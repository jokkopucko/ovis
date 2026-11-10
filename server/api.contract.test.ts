import type { SystemReport } from "../shared/system.ts";
import { describe, expect, it, beforeAll, afterAll, spyOn } from "bun:test";
import { CLEAR_LEGACY_DEVICE_COOKIE, DEVICE_COOKIE_CLEARED } from "./auth.ts";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, mkdirSync, mkdtempSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, openSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ConversationMonitor } from "./conversation-monitor.ts";
import { createServer } from "./index.ts";
import { AgentDetector, catalogLocator } from "./agent-catalog-detect.ts";
import * as appModule from "./index.ts";
import * as herdrClient from "./herdr/client.ts";
import type { AgentKind, AgentStatus, ApiError, HealthAuth, IntegrationsResponse, LanExposure, PortalStatus, SecuritySummary, PushKey, RemoteAccess, SessionSnapshot, TabMoved, TabMovedToWorkspace, PaneFindResponse, PaneReadResult, UsageReport, WorkspaceCreated, WorktreeListing, WorktreeOpened, WorktreeRemoved } from "../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../shared/supported-agents.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import { PortalService } from "./portal.ts";
import { noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type HerdrUpdateStatus, type InstalledNotes, type UpdateNotes, type UpdateStatus } from "../shared/update.ts";
import { USAGE_PROVIDERS, UsageService } from "./usage.ts";
import { VoiceService } from "./voice.ts";
import { Telemetry } from "./telemetry.ts";
import { NOTICE_VERSION, telemetryHarnesses, type TelemetryActive, type TelemetryEvent, type TelemetryStatus } from "../shared/telemetry.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot } from "../src/lib/settings.ts";
import { HerdrSocket } from "../src/lib/ws.ts";
import { HerdrError, herdrRpc, paneRead, paneSplit, ping, sessionSnapshot, subscribeEvents, tabCreate, workspaceCreate, workspaceClose } from "./herdr/client.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { descriptorPath, type BridgeDescriptor } from "./bridge.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import { TailnetIdentitySource } from "./tailscale.ts";
import { forgetTranscriptState } from "./conversation.ts";
import type { RepoDiffFileList, RepoDiffFilePatch, RepoDiffRefs, SessionHistoryResponse, SessionResumeResponse } from "../shared/protocol.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { testShellEnv } from "../scripts/test-shell.ts";
import { PendingInputError, PendingInputs } from "./pending-input.ts";
import { loginPathProbe, ShellAgentLocator, type LoginPathProbe } from "./shell-agent.ts";
import { DeviceStore } from "./devices.ts";
import type { HerdrCoreFacts, HerdrRuntimeFacts, MachineEvent, MachineSettings } from "../shared/machines.ts";
import type { RuntimeService, SwitchAnswer } from "./herdr-core/runtime-choice.ts";
import { MAX_MUTED_PANES, type SharedPreferences } from "../shared/preferences.ts";
import { OmoStatus } from "./omo-status.ts";
import { omoJobTasks } from "./omo-jobs.ts";
import { ClaudeSubagentStatus } from "./claude-subagents.ts";
import { setFilePoolOptions } from "./file-pool.ts";
import { SLEEP } from "../scripts/fixtures/sleep.ts";

/**
 * Contract test for Ovis's HTTP + WS surface.
 * Runs against the REAL herdr server on the developer's machine: these are the
 * integration seams the browser UI depends on, so a mock here would prove nothing.
 * Tests never mutate a user's pane; mutation cases create labeled workspaces and close them in afterAll.
 * Every server here keeps its push state (VAPID key, subscriptions) in a temp dir: the
 * user's ~/.config/herdr-web-ui holds their real devices, which a test must never page.
 */
let server: { port: number; stop: () => void };
const stateDir = mkdtempSync(join(tmpdir(), "ovis-contract-"));

beforeAll(async () => {
  const started = createServer({ port: 0, stateDir, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
  server = started;
  // herdr's events are heard from here on: a workspace a test creates is pushed as session-changed
  await started.statusReady;
});

afterAll(() => {
  server?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${server.port}`;

describe("removed Chat rewind API", () => {
  it("returns 404 for local and machine-prefixed rewind requests", async () => {
    for (const path of ["/api/pane/rewind", "/api/machines/local/pane/rewind"]) {
      const response = await fetch(base() + path, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ pane_id: "not-a-live-pane", text: "nothing to send" }),
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe("Grok conversation API", () => {
  it.skipIf(process.platform !== "linux")("uses exact process/session evidence, validators and revision-bound output refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-grok-contract-"));
    const id = "00000000-0000-4000-8000-000000000001";
    const directory = join(root, "sessions", "%2Ffictional", id);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "updates.jsonl");
    const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: id, update } }) + "\n";
    const user = event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "fictional prompt" }, _meta: { promptIndex: 0 } });
    const call = event({ sessionUpdate: "tool_call", toolCallId: "fictional-call", title: "Read", rawInput: { path: "fiction.txt" } });
    const output = (text: string) => event({ sessionUpdate: "tool_call_update", toolCallId: "fictional-call", content: [{ type: "content", content: { type: "text", text } }] });
    writeFileSync(path, user + call + output("x".repeat(5000)));
    const events = join(directory, "events.jsonl");
    writeFileSync(events, "");
    // An older session kept open beside the reported one. It must not hide the reported file.
    const retained = join(root, "sessions", "%2Ffictional", "00000000-0000-4000-8000-000000000003", "events.jsonl");
    mkdirSync(join(retained, ".."), { recursive: true });
    writeFileSync(retained, "");
    utimesSync(retained, 100, 100);
    utimesSync(events, 200, 200);
    // A native stand-in owns the fd evidence and only sleeps; no model or user's store.
    const executable = join(root, "grok");
    const nativeExecutable = join(root, "grok-1.0.52-linux-x86_64");
    copyFileSync(SLEEP, nativeExecutable); symlinkSync("grok-1.0.52-linux-x86_64", executable); chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-grok-api" });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable} 600 3<${events} 4<${retained}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "grok") break;
        if (Date.now() > deadline) throw new Error("fixture Grok process did not start");
        await Bun.sleep(50);
      }
      let reportSequence = 0;
      // Stands in for the SessionStart report Grok's herdr integration makes: Herdr 0.9.3
      // replaces a Grok ID only for a newer "new" report.
      const report = (session: string, source = "new") => herdrRpc("pane.report_agent_session", { pane_id: paneId, agent: "grok", source: "herdr:grok", seq: ++reportSequence, agent_session_id: session, session_start_source: source });
      await report(id);
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), grokHome: root });
      const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
      const first = await fetch(url);
      const body = await first.json();
      expect(body.source).toBe("grok-transcript");
      expect(body.activity).toBe("working");
      expect(body.turns[0].parts[0].text).toBe("fictional prompt");
      // An update can unlink the running binary: /proc/<pid>/exe gains " (deleted)".
      unlinkSync(nativeExecutable);
      expect((await (await fetch(url)).json()).source).toBe("grok-transcript");
      expect((await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } })).status).toBe(304);
      const ref = body.turns[1].parts[0].output_ref;
      const outputUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref })}`;
      const whole = await fetch(outputUrl);
      expect(whole.headers.get("cache-control")).toBe("private, no-store");
      expect(await whole.text()).toBe("x".repeat(5000));
      appendFileSync(path, output("y".repeat(5000)));
      expect((await fetch(outputUrl)).status).toBe(404);
      const next = await fetch(url);
      expect(next.headers.get("etag")).not.toBe(first.headers.get("etag"));
      appendFileSync(path, event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fictional thought" } }));
      const thinking = await fetch(url);
      expect((await thinking.json()).activity).toBe("thinking");
      expect(thinking.headers.get("etag")).not.toBe(next.headers.get("etag"));
      appendFileSync(path, event({ sessionUpdate: "turn_completed" }));
      expect((await (await fetch(url)).json()).activity).toBe("idle");
      appendFileSync(path, event({ sessionUpdate: "rewind_marker", target_prompt_index: 0 }, true));
      expect((await fetch(`${url}&from=${encodeURIComponent(`${body.history_id}:0`)}`)).status).toBe(409);
      const local = await fetch(url.replace("/api/pane/", "/api/machines/local/pane/"));
      expect((await local.json()).turns).toEqual([]);
      const missing = "00000000-0000-4000-8000-000000000002";
      await report(missing, "resume");
      expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent_session?.value).toBe(id);
      await report(missing);
      for (const deadline = Date.now() + 5000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent_session?.value === missing) break;
        if (Date.now() > deadline) throw new Error("Herdr did not apply the second session report");
        await Bun.sleep(50);
      }
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      app?.stop(); await workspaceClose(created.workspace.workspace_id);
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Agy conversation API", () => {
  it.skipIf(process.platform !== "linux")("binds the selected held lock, honors saved rewinds and recovers from an unwritten store", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-agy-contract-"));
    const id = "00000000-0000-4000-8000-000000000031";
    const path = join(root, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(join(root, "conversations")); mkdirSync(join(root, "presence"));
    const lock = join(root, "presence", `${id}.lock`);
    writeFileSync(lock, "");
    // Another unheld lock in the same store must never select a conversation.
    writeFileSync(join(root, "presence", "00000000-0000-4000-8000-000000000032.lock"), "");
    const executable = join(root, "agy");
    copyFileSync(SLEEP, executable); chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-agy-api" });
    let app: ReturnType<typeof createServer> | undefined, db: Database | undefined;
    let monitor: ConversationMonitor | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable} 600 3<${lock}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "agy") break;
        if (Date.now() > deadline) throw new Error("fixture Agy process did not start");
        await Bun.sleep(50);
      }
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
      const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
      db = new Database(join(root, "conversations", `${id}.db`));
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
      const empty = await (await fetch(url)).json();
      expect(empty.source).toBe("agy-transcript"); expect(empty.turns).toEqual([]);
      const row = (step_index: number, type: string, content: string) => JSON.stringify({ step_index, type, status: "DONE", content }) + "\n";
      db.exec("INSERT INTO steps VALUES (0), (1)");
      writeFileSync(path, row(0, "USER_INPUT", "fictional prompt") + row(1, "GENERIC", "x".repeat(5000)));
      const first = await fetch(url), body = await first.json();
      expect(body.source).toBe("agy-transcript");
      expect(body.activity).toBe("working");
      expect(body.turns[0].parts[0].text).toBe("fictional prompt");
      expect((await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } })).status).toBe(304);
      const ref = body.turns[1].parts[0].output_ref;
      const outputUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref })}`;
      expect(await (await fetch(outputUrl)).text()).toBe("x".repeat(5000));
      db.exec("INSERT INTO steps VALUES (2)");
      appendFileSync(path, row(2, "PLANNER_RESPONSE", "Finished"));
      const completed = await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } });
      expect(completed.status).toBe(200);
      expect((await completed.json()).activity).toBe("idle");
      expect(completed.headers.get("etag")).not.toBe(first.headers.get("etag"));
      db.exec("INSERT INTO steps VALUES (3)");
      appendFileSync(path, row(3, "USER_INPUT", "New work"));
      expect((await (await fetch(url)).json()).activity).toBe("working");
      const changes: string[] = [];
      monitor = new ConversationMonitor((_pane, signature) => changes.push(signature));
      monitor.watch(paneId);
      const changed = async (count: number) => {
        for (const deadline = Date.now() + 5000; changes.length <= count;) {
          if (Date.now() > deadline) throw new Error("Agy catalog change was not pushed");
          await Bun.sleep(20);
        }
      };
      await changed(0);
      const beforeCut = changes.length;
      db.exec("DELETE FROM steps WHERE idx >= 1");
      await changed(beforeCut);
      expect((await (await fetch(url)).json()).turns).toHaveLength(1);
      expect((await fetch(`${url}&from=${encodeURIComponent(`${body.history_id}:0`)}`)).status).toBe(409);
      expect((await fetch(outputUrl)).status).toBe(404);
      forgetTranscriptState();
      const local = await fetch(url.replace("/api/pane/", "/api/machines/local/pane/"));
      expect((await local.json()).turns).toHaveLength(1);
      db.exec("DROP TABLE steps");
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      monitor?.stop(); app?.stop(); db?.close(); await workspaceClose(created.workspace.workspace_id);
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Muse conversation API", () => {
  it.skipIf(process.platform === "win32")("binds the session whose lock names the pane's Muse process, and follows a switch to another session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-muse-contract-"));
    // the session Muse 1.4.13 recorded, live: without the `session.end` that its /exit wrote
    const recorded = readFileSync(join(import.meta.dir, "fixtures", "muse", "recorded-1.4.13.jsonl"), "utf8").split("\n");
    const end = recorded.at(-2)!;
    const live = `${recorded.slice(0, -2).join("\n")}\n`;
    const sessions = join(root, "data", "sessions", "2026", "10", "25");
    // each session's folder is named after it, as Muse names it
    const first = join(sessions, "01a17441-bc95-7e23-b488-988dceb829cd");
    const second = join(sessions, "01a17445-0000-7000-8000-000000000002");
    mkdirSync(first, { recursive: true }); mkdirSync(second);
    // a link, not a copy: macOS kills a copied system binary, and argv keeps the name it was run by
    const executable = join(root, "muse");
    symlinkSync(SLEEP, executable);
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-muse-api" });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable} 600\n` });
      let pid: number | undefined;
      for (const deadline = Date.now() + 10_000;;) {
        const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
        const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
        pid = info.process_info?.foreground_processes?.find((process) => process.argv?.[0] === executable)?.pid;
        if (pane?.agent === "muse" && pid !== undefined) break;
        if (Date.now() > deadline) throw new Error(`fixture Muse process did not start: ${pane?.agent} ${JSON.stringify(info.process_info?.foreground_processes)}`);
        await Bun.sleep(50);
      }
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), museData: join(root, "data") });
      const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
      // a session no lock ties to this process is never shown, whatever its folder or age
      writeFileSync(join(first, "session.jsonl"), live);
      writeFileSync(join(first, ".session.lock"), `pid=${pid! + 1}\nhost=${hostname()}\n`);
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
      writeFileSync(join(first, ".session.lock"), `pid=${pid}\nhost=${hostname()}\n`);
      // the scan that found nothing stands for 2 s, as for a fresh Muse that has written no log yet
      let response: Response, body;
      for (const deadline = Date.now() + 5000;;) {
        response = await fetch(url); body = await response.json();
        if (body.source === "muse-transcript" || Date.now() > deadline) break;
        await Bun.sleep(100);
      }
      expect(body.source).toBe("muse-transcript");
      expect(body.turns.map((turn: { role: string }) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
      expect(body.metadata.model).toBe("muse-spark-1.2");
      expect((await fetch(url, { headers: { "if-none-match": response.headers.get("etag")! } })).status).toBe(304);
      const outputUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref: "call_01a1744243497078923c0e3306f4900d" })}`;
      expect(await (await fetch(outputUrl)).text()).toBe("ls: missing-folder: No such file or directory\n");
      // the TUI switches sessions: the one left behind ends, the new one holds a lock for the same pid
      appendFileSync(join(first, "session.jsonl"), `${end}\n`);
      const prompt = recorded.find((line) => line.includes('"runtime.user_intent.accepted"'))!.replace("01a17441-bc95-7e23-b488-988dceb829cd", "01a17445-0000-7000-8000-000000000002");
      writeFileSync(join(second, "session.jsonl"), `${prompt}\n`);
      writeFileSync(join(second, ".session.lock"), `pid=${pid}\nhost=${hostname()}\n`);
      const switched = await (await fetch(url)).json();
      expect(switched.turns).toHaveLength(1);
      expect(switched.history_id).not.toBe(body.history_id);
      expect((await fetch(outputUrl)).status).toBe(404);
      // a record in a shape the reader does not know, or a log it cannot read, shows Terminal
      const log = join(second, "session.jsonl");
      appendFileSync(log, `${prompt.replace('"runtime.user_intent.accepted"', '"runtime.user_intent.renamed"')}\n`);
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
      writeFileSync(log, `${prompt}\n`);
      expect((await (await fetch(url)).json()).source).toBe("muse-transcript");
      // root reads a file whatever its mode
      if (process.getuid?.() !== 0) {
        chmodSync(log, 0);
        expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
      }
    } finally {
      app?.stop(); await workspaceClose(created.workspace.workspace_id);
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("single-pane context lookup", () => {
  for (const route of ["commands", "files"] as const) {
    it(`rejects an unknown pane on /api/pane/${route} with the shared error envelope`, async () => {
      const response = await fetch(`${base()}/api/pane/${route}?pane_id=w9999:p9999`);
      expect(response.status).toBe(404);
      const body: ApiError = await response.json();
      expect(body.error.code).toBe("pane_not_found");
      expect(typeof body.error.message).toBe("string");
    });
  }
});

describe("GET /api/pane/plan", () => {
  it("requires GET and a pane id with the shared error envelope", async () => {
    for (const [url, method, code] of [
      [`${base()}/api/pane/plan`, "GET", "missing_pane_id"],
      [`${base()}/api/pane/plan?pane_id=w9999:p9999`, "POST", "method_not_allowed"],
    ] as const) {
      const response = await fetch(url, { method });
      expect(response.status).toBe(400);
      const body: ApiError = await response.json();
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
  });
});

describe("Devin conversation API", () => {
  it("keeps the terminal fallback rather than guessing a shell pane's session", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-devin-contract-"));
    const created = await workspaceCreate({ cwd: state, label: "ovis-test-devin-identity" });
    const dbPath = join(state, "sessions.db");
    let bridge: ReturnType<typeof createServer> | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      const snapshot = await sessionSnapshot();
      const pane = snapshot.panes.find((entry) => entry.pane_id === paneId)!;
      const cwd = pane.foreground_cwd || pane.cwd;
      if (!cwd) throw new Error("test pane has no working directory");
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT)");
        db.query("INSERT INTO sessions VALUES ('synthetic', ?, NULL, 0, NULL)").run(cwd);
      } finally { db.close(); }
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "devin", state: "idle" });
      bridge = createServer({ port: 0, stateDir: state, devinDbPath: dbPath });
      const response = await fetch(`http://localhost:${bridge.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      bridge?.stop();
      await workspaceClose(created.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("native tool call id and state on GET /api/pane/conversation", () => {
  it.skipIf(process.platform !== "linux")("carries Claude's id and recorded outcome, Codex's id and pending only, and neither for another agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-call-state-contract-"));
    const cwd = realpathSync(root);
    const originalHome = process.env["HOME"];
    const claudeId = "6f1c2a9e-0b7d-4c3e-8a51-2d9f0e7b4c11";
    const claudeFile = join(cwd, ".claude", "projects", claudeProjectDir(cwd), `${claudeId}.jsonl`);
    const codexHome = join(cwd, "codex");
    const codexFile = join(codexHome, "sessions", "2026", "10", "21", "rollout-2026-10-21T09-00-00-00000000-0000-4000-8000-000000000014.jsonl");
    const ompFile = join(cwd, ".omp", "agent", "sessions", "-call-state", "2026-10-21T00-00-00-000Z_omp-call-state.jsonl");
    for (const file of [claudeFile, codexFile, ompFile]) mkdirSync(join(file, ".."), { recursive: true });
    const line = (record: unknown) => `${JSON.stringify(record)}\n`;
    const todos = { todos: [{ content: "Read", status: "completed", activeForm: "Reading" }] };
    const claudeUse = (id: string) => line({ type: "assistant", timestamp: "2026-10-21T09:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "TodoWrite", input: todos }] } });
    const claudeResult = (id: string, content: string, isError?: boolean) => line({ type: "user", timestamp: "2026-10-21T09:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });
    writeFileSync(claudeFile, line({ type: "user", timestamp: "2026-10-21T09:00:00.000Z", message: { role: "user", content: "plan it" } }) + claudeUse("toolu_ok") + claudeUse("toolu_err") + claudeUse("toolu_wait"));
    const codexCall = (id: string, kind: "function_call" | "custom_tool_call") => line({ type: "response_item", timestamp: "2026-10-21T09:00:01.000Z", payload: kind === "function_call"
      ? { type: kind, call_id: id, name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }] }) }
      : { type: kind, call_id: id, name: "apply_patch", input: "*** Begin Patch\n*** End Patch" } });
    const codexOutput = (id: string, kind: "function_call_output" | "custom_tool_call_output", output: string) => line({ type: "response_item", timestamp: "2026-10-21T09:00:02.000Z", payload: { type: kind, call_id: id, output } });
    writeFileSync(codexFile, line({ type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000014", timestamp: "2026-10-21T09:00:00.000Z", cwd, source: "cli" } })
      + line({ type: "event_msg", timestamp: "2026-10-21T09:00:00.000Z", payload: { type: "user_message", message: "plan it" } })
      + codexCall("call_fn", "function_call") + codexCall("call_custom", "custom_tool_call") + codexCall("call_fail_text", "function_call"));
    writeFileSync(ompFile, [
      { type: "session", version: 3, id: "omp-call-state", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-21T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "plan it" }] } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-21T09:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "omp_call_1", name: "todo", arguments: { op: "init", list: [{ phase: "Plan", items: ["Read"] }] } }] } },
      { type: "message", id: "r1", parentId: "a1", timestamp: "2026-10-21T09:00:02.000Z", message: { role: "toolResult", toolCallId: "omp_call_1", toolName: "todo", isError: false, content: [{ type: "text", text: "Overall: 0/1 done.\n  Plan:\n    - [ ] Read" }] } },
    ].map(line).join(""));
    const workspaces: string[] = [];
    let app: ReturnType<typeof createServer> | undefined;
    let seq = Date.now() * 1000;
    const agentPane = async (agent: string, session: Record<string, string>): Promise<string> => {
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-call-state-${agent}` });
      workspaces.push(created.workspace.workspace_id);
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent, state: "idle" });
      await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: `herdr:${agent}`, agent, seq: ++seq, ...session });
      return paneId;
    };
    try {
      process.env["HOME"] = cwd;
      forgetTranscriptState();
      const claude = await agentPane("claude", { agent_session_id: claudeId });
      // Codex is found by the rollout its process holds open: a native stand-in that only sleeps
      const codexExe = join(cwd, "bin", "codex");
      mkdirSync(join(cwd, "bin"));
      copyFileSync(SLEEP, codexExe); chmodSync(codexExe, 0o755);
      const codexCreated = await workspaceCreate({ cwd, label: "herdr-web-ui-test-call-state-codex" });
      workspaces.push(codexCreated.workspace.workspace_id);
      const codex = codexCreated.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: codex, text: `${codexExe} 600 3<${codexFile}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === codex)?.agent === "codex") break;
        if (Date.now() > deadline) throw new Error("fixture Codex process did not start");
        await Bun.sleep(50);
      }
      // omp's session report is taken for a pane herdr sees running omp: the same kind of stand-in
      const ompExe = join(cwd, "bin", "omp");
      copyFileSync(SLEEP, ompExe); chmodSync(ompExe, 0o755);
      const ompCreated = await workspaceCreate({ cwd, label: "herdr-web-ui-test-call-state-omp" });
      workspaces.push(ompCreated.workspace.workspace_id);
      const omp = ompCreated.root_pane.pane_id;
      // omp keeps its sessions under its own home, which the bridge reads from the process (#1898)
      await herdrRpc("pane.send_text", { pane_id: omp, text: `HOME='${cwd}' exec '${ompExe}' 600\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === omp)?.agent === "omp") break;
        if (Date.now() > deadline) throw new Error("fixture omp process did not start");
        await Bun.sleep(50);
      }
      await herdrRpc("pane.report_agent", { pane_id: omp, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
      await herdrRpc("pane.report_agent_session", { pane_id: omp, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: ompFile, session_start_source: "startup" });
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(cwd, "state"), codexHome });
      const tools = async (paneId: string, source: string) => {
        const response = await fetch(`http://127.0.0.1:${app!.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
        expect(response.status).toBe(200);
        const body = await response.json() as { source: string; turns: { parts: Record<string, unknown>[] }[] };
        expect(body.source).toBe(source);
        return body.turns.flatMap((turn) => turn.parts).filter((part) => part["kind"] === "tool");
      };
      const idState = (parts: Record<string, unknown>[]) => parts.map((part) => [part["call_id"], "state" in part ? part["state"] : "omitted"]);

      // before any result: every native call is pending under its own id
      expect(idState(await tools(claude, "claude-transcript"))).toEqual([["toolu_ok", "pending"], ["toolu_err", "pending"], ["toolu_wait", "pending"]]);
      expect(idState(await tools(codex, "codex-transcript"))).toEqual([["call_fn", "pending"], ["call_custom", "pending"], ["call_fail_text", "pending"]]);

      // results appended: Claude's flag decides (an empty result is ok); the next poll replaces the page
      appendFileSync(claudeFile, claudeResult("toolu_ok", "") + claudeResult("toolu_err", "<tool_use_error>InputValidationError</tool_use_error>", true));
      expect(idState(await tools(claude, "claude-transcript"))).toEqual([["toolu_ok", "ok"], ["toolu_err", "error"], ["toolu_wait", "pending"]]);
      // Codex records no outcome: either output record ends pending, empty or failure-looking alike
      appendFileSync(codexFile, codexOutput("call_fn", "function_call_output", "") + codexOutput("call_custom", "custom_tool_call_output", "applied")
        + codexOutput("call_fail_text", "function_call_output", "Error: plan update failed\nProcess exited with code 1"));
      expect(idState(await tools(codex, "codex-transcript"))).toEqual([["call_fn", "omitted"], ["call_custom", "omitted"], ["call_fail_text", "omitted"]]);

      // another agent's parser fabricates neither, though its transcript has ids of its own
      const ompTools = await tools(omp, "omp-transcript");
      expect(ompTools).toHaveLength(1);
      expect(["call_id" in ompTools[0]!, "state" in ompTools[0]!]).toEqual([false, false]);
    } finally {
      app?.stop();
      for (const id of workspaces) await workspaceClose(id);
      if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("a Claude bash-mode command on GET /api/pane/conversation", () => {
  it("answers it as one shell part, and leaves out the streams Claude Code has not recorded yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-bash-mode-contract-"));
    const cwd = realpathSync(root);
    const originalHome = process.env["HOME"];
    const id = "3b7e9c2a-5d14-4f8b-9a63-0c2e7f1d8b45";
    const file = join(cwd, ".claude", "projects", claudeProjectDir(cwd), `${id}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    const user = (content: string, second: number) => `${JSON.stringify({ type: "user", timestamp: `2026-10-27T03:00:0${second}.000Z`, message: { role: "user", content } })}\n`;
    writeFileSync(file, user('<bash-input>echo "Hello"</bash-input>', 0) + user("<bash-stdout>Hello</bash-stdout><bash-stderr></bash-stderr>", 1)
      + user("<bash-input>ls missing</bash-input>", 2) + user("<bash-stdout></bash-stdout><bash-stderr>ls: missing: No such file or directory</bash-stderr>", 3)
      + user("<bash-input>sleep 60</bash-input>", 4));
    let app: ReturnType<typeof createServer> | undefined;
    let workspace: string | undefined;
    try {
      process.env["HOME"] = cwd;
      forgetTranscriptState();
      const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-bash-mode" });
      workspace = created.workspace.workspace_id;
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
      await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:claude", agent: "claude", seq: Date.now() * 1000, agent_session_id: id });
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(cwd, "state") });
      const response = await fetch(`http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { source: string; turns: { role: string; parts: unknown[] }[] };
      expect(body.source).toBe("claude-transcript");
      expect(body.turns.map((turn) => [turn.role, turn.parts])).toEqual([
        ["user", [{ kind: "shell", command: 'echo "Hello"', stdout: "Hello", stderr: "" }]],
        ["user", [{ kind: "shell", command: "ls missing", stdout: "", stderr: "ls: missing: No such file or directory" }]],
        // no output entry yet: the JSON has neither stream, not empty ones
        ["user", [{ kind: "shell", command: "sleep 60" }]],
      ]);
    } finally {
      app?.stop();
      if (workspace !== undefined) await workspaceClose(workspace);
      if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("GET /api/pane/conversation/search", () => {
  it("finds a Claude pane's messages and answers on every page, never a tool's output, and goes on from its cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-search-contract-"));
    const cwd = realpathSync(root);
    const originalHome = process.env["HOME"];
    const id = "5c1d7e3f-2a48-4b96-8e05-9f3a6c2d1b74";
    const file = join(cwd, ".claude", "projects", claudeProjectDir(cwd), `${id}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    // 120 prompts: three pages of 50; the user's words on the first page, the answer on the last
    const at = (n: number, step: number) => new Date(Date.parse("2026-10-27T03:00:00.000Z") + (n * 4 + step) * 1000).toISOString();
    writeFileSync(file, Array.from({ length: 120 }, (_, n) => [
      { type: "user", timestamp: at(n, 0), uuid: `u${n}`, message: { role: "user", content: n === 5 ? "Why does the deploy script fail?" : `prompt ${n}` } },
      { type: "assistant", timestamp: at(n, 1), uuid: `c${n}`, message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: "make" } }] } },
      { type: "user", timestamp: at(n, 2), uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "the deploy script printed this" }] } },
      { type: "assistant", timestamp: at(n, 3), uuid: `a${n}`, message: { role: "assistant", content: [{ type: "text", text: n === 110 ? "The deploy script needs its token." : `answer ${n}` }] } },
    ].map((line) => JSON.stringify(line)).join("\n")).join("\n") + "\n");
    let app: ReturnType<typeof createServer> | undefined;
    let workspace: string | undefined;
    try {
      process.env["HOME"] = cwd;
      forgetTranscriptState();
      const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-conversation-search" });
      workspace = created.workspace.workspace_id;
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
      await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:claude", agent: "claude", seq: Date.now() * 1000, agent_session_id: id });
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(cwd, "state") });
      const ask = (query: Record<string, string>) => fetch(`http://127.0.0.1:${app!.port}/api/pane/conversation/search?${new URLSearchParams({ pane_id: paneId, ...query })}`);
      const found: { role: string; before: string; match: string; after: string }[] = [];
      let answer = await (await ask({ q: "Deploy  Script" })).json() as { history_id: string; cursor: string | null; matches: typeof found };
      for (let asked = 1; ; asked++) {
        found.push(...answer.matches.map(({ role, before, match, after }) => ({ role, before, match, after })));
        if (answer.cursor === null) break;
        expect(asked).toBeLessThan(5);
        answer = await (await ask({ q: "Deploy  Script", before: answer.cursor, history_id: answer.history_id })).json() as typeof answer;
      }
      expect(found).toEqual([
        { role: "assistant", before: "The ", match: "deploy script", after: " needs its token." },
        { role: "user", before: "Why does the ", match: "deploy script", after: " fail?" },
      ]);
      // a cursor from another history, and a query it cannot search
      expect((await ask({ q: "deploy", before: "0", history_id: "another" })).status).toBe(409);
      expect((await ask({ q: " " })).status).toBe(400);
    } finally {
      app?.stop();
      if (workspace !== undefined) await workspaceClose(workspace);
      if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("usage API", () => {
  it.each([false, true])("serializes missing_commands when Linux secret-tool availability is %s", async (installed) => {
    // Given: no Antigravity credentials and an isolated command lookup.
    const usageState = mkdtempSync(join(tmpdir(), "herdr-usage-missing-command-"));
    const usage = new UsageService({
      home: usageState, env: {}, platform: "linux", now: () => Date.parse("2026-10-06T00:00:00Z"),
      keychain: async () => ({ status: "missing" }), run: async () => null,
      has: (command) => command !== "secret-tool" || installed,
      fetch: async () => { throw new Error("usage must not fetch without credentials"); },
    }, USAGE_PROVIDERS.filter((provider) => provider.id === "antigravity"));
    const app = createServer({ port: 0, stateDir: usageState, usage });
    try {
      // When
      const response = await fetch(`http://localhost:${app.port}/api/usage`);
      // Then
      expect(response.status).toBe(200);
      const report: UsageReport = await response.json();
      expect(report.providers).toEqual([]);
      if (installed) expect(report).not.toHaveProperty("missing_commands");
      else expect(report.missing_commands).toEqual([{ provider: "antigravity", command: "secret-tool" }]);
    } finally { app.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });

  it("returns OpenCode Go windows without exposing its credential", async () => {
    const usageState = mkdtempSync(join(tmpdir(), "herdr-opencode-contract-"));
    const token = "oc_sk_contract_only";
    const usage = new UsageService({
      home: usageState, env: { OPENCODE_API_KEY: token }, platform: "linux", now: () => Date.parse("2026-10-06T00:00:00Z"),
      keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true,
      fetch: async (url, init) => {
        expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({ usage: {
          rolling: { percent: 12, resetsAt: "2026-10-06T01:00:00Z" },
          weekly: { percent: 34 }, monthly: { percent: 56 },
        } });
      },
    }, USAGE_PROVIDERS.filter((provider) => provider.id === "opencode"));
    const app = createServer({ port: 0, stateDir: usageState, usage, token: "report-token" });
    try {
      const url = `http://localhost:${app.port}/api/usage`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: "Bearer report-token" } });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(usageState);
      expect((JSON.parse(body) as UsageReport).providers).toMatchObject([{
        id: "opencode", account: null, plan: "Go", problem: null,
        windows: [
          { kind: "session", used_percent: 12, resets_at: "2026-10-06T01:00:00.000Z" },
          { kind: "week", used_percent: 34 }, { kind: "month", used_percent: 56 },
        ],
      }]);
    } finally { app.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });

  it("answers the report and keeps it behind the token gate", async () => {
    const usageState = mkdtempSync(join(tmpdir(), "herdr-usage-auth-"));
    const usage = new UsageService(undefined, []);
    const open = createServer({ port: 0, stateDir: usageState, usage });
    const gated = createServer({ port: 0, stateDir: usageState, usage, token: "test-usage-token" });
    try {
      const answered = await fetch(`http://localhost:${open.port}/api/usage`);
      expect(answered.status).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("no-store");
      expect(await answered.json() as UsageReport).toEqual({ providers: [] });
      expect((await fetch(`http://localhost:${gated.port}/api/usage`)).status).toBe(401);
      const withToken = await fetch(`http://localhost:${gated.port}/api/usage`, { headers: { authorization: "Bearer test-usage-token" } });
      expect(withToken.status).toBe(200);
    } finally { open.stop(); gated.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });
});

describe("system API", () => {
  const report: SystemReport = { sampled_at: 1, platform: "linux", uptime_s: 5, cpu_count: 2, cpu_percent: 10, memory: null, load: null, disks: [] };
  const sampler = { read: async () => report };

  it("answers GET without caching, keeps it behind the token gate, and takes the bridge token too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-system-contract-"));
    const open = createServer({ port: 0, stateDir: dir, system: sampler });
    const bridge = "b".repeat(64);
    const gated = createServer({ port: 0, stateDir: dir, system: sampler, token: "system-test-token", bridgeToken: bridge });
    const machineServer = createServer({ port: 0, stateDir: dir, system: null });
    try {
      const answered = await fetch(`http://localhost:${open.port}/api/system`);
      expect(answered.status).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("no-store");
      expect(await answered.json()).toEqual(report);
      expect((await fetch(`http://localhost:${gated.port}/api/system`)).status).toBe(401);
      const withToken = await fetch(`http://localhost:${gated.port}/api/system`, { headers: { authorization: "Bearer system-test-token" } });
      expect(withToken.status).toBe(200);
      // another PC's app reads it through its bridge token, by GET only
      expect((await fetch(`http://localhost:${gated.port}/api/system`, { headers: { authorization: `Bearer ${bridge}` } })).status).toBe(200);
      expect((await fetch(`http://localhost:${gated.port}/api/system`, { method: "POST", headers: { authorization: `Bearer ${bridge}` } })).status).toBe(401);
      expect((await fetch(`http://localhost:${open.port}/api/system`, { method: "POST", headers: { origin: `http://localhost:${open.port}` } })).status).toBe(405);
      // a server without a load of its own to tell answers as one without the route
      expect((await fetch(`http://localhost:${machineServer.port}/api/system`)).status).toBe(404);
    } finally { open.stop(); gated.stop(); machineServer.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("voice API", () => {
  it("keeps the key on the server, refuses cross-site writes and streams a transcript", async () => {
    const voiceState = mkdtempSync(join(tmpdir(), "herdr-voice-contract-"));
    const key = "sk-contract-0123456789";
    const provider = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/audio/transcriptions") return new Response("not found", { status: 404 });
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        await request.formData();
        return new Response(`data: ${JSON.stringify({ type: "transcript.text.done", text: "git status" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const voice = new VoiceService({ stateDir: voiceState, env: { OVIS_OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1` }, fetch });
    const open = createServer({ port: 0, stateDir: voiceState, voice });
    const gated = createServer({ port: 0, stateDir: voiceState, voice, token: "test-voice-token" });
    const at = (path: string) => `http://localhost:${open.port}${path}`;
    try {
      expect((await fetch(`http://localhost:${gated.port}/api/voice`)).status).toBe(401);
      expect(await (await fetch(at("/api/voice"))).json()).toMatchObject({ configured: false, source: null });

      const crossSite = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ api_key: key }) });
      expect(crossSite.status).toBe(403);
      const saved = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key }) });
      expect(saved.status).toBe(200);
      const status = await (await fetch(at("/api/voice"))).text();
      expect(JSON.parse(status)).toMatchObject({ configured: true, source: "file" });
      expect(status).not.toContain(key);
      expect(statSync(join(voiceState, "voice.json")).mode & 0o777).toBe(0o600);

      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "voice.webm");
      form.append("mode", "chat");
      form.append("polish", "0");
      const transcribed = await fetch(at("/api/voice/transcribe"), { method: "POST", body: form });
      expect(transcribed.headers.get("content-type")).toContain("application/x-ndjson");
      expect((await transcribed.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ type: "done", text: "git status" }]);
    } finally {
      open.stop(); gated.stop(); provider.stop(true);
      rmSync(voiceState, { recursive: true, force: true });
    }
  });
});

describe("update API", () => {
  it("reports unmanaged servers without performing network discovery", async () => {
    const response = await fetch(`${base()}/api/updates`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { managed: boolean }).managed).toBe(false);
  });

  it("answers what the available update brings, and nothing where no supervisor told it", async () => {
    const none = await fetch(`${base()}/api/updates/notes`);
    expect(none.status).toBe(200);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ revision: null, releases: [], omitted: 0 });
    expect((await fetch(`${base()}/api/updates/notes`, { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(405);

    const notes: UpdateNotes = { revision: "b".repeat(40), releases: [{ version: "9.9.9", date: "2026-10-07", notes: "### Added\n- A thing." }], omitted: 2 };
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-notes-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => ({ ...unmanagedUpdateStatus(), managed: true, available: true }), notes: () => notes, installed: noInstalledNotes, request() {} } });
    try {
      expect(await (await fetch(`http://localhost:${managed.port}/api/updates/notes`)).json()).toEqual(notes);
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
  });

  it("tells the served build's commit once it differs from the running revision", async () => {
    const running = "a".repeat(40), moved = "d".repeat(40);
    let head: string | null = running;
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-checkout-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => ({ ...unmanagedUpdateStatus(), managed: true, current_revision: running }), notes: () => ({ revision: null, releases: [], omitted: 0 }),
        installed: noInstalledNotes, request() {}, servedRevision: async () => head } });
    const read = async () => (await (await fetch(`http://localhost:${managed.port}/api/updates`)).json()) as { served_revision?: string | null };
    try {
      expect((await read()).served_revision).toBeNull();
      head = moved;
      expect((await read()).served_revision).toBe(moved);
      head = null;
      expect((await read()).served_revision).toBeNull();
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
    // an unmanaged server names no checkout
    expect((await (await fetch(`${base()}/api/updates`)).json() as { served_revision?: string | null }).served_revision).toBeUndefined();
  });

  it("answers what the last update brought, and nothing where no update was installed", async () => {
    const none = await fetch(`${base()}/api/updates/installed`);
    expect(none.status).toBe(200);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 });
    expect((await fetch(`${base()}/api/updates/installed`, { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(405);

    const installed: InstalledNotes = { revision: "c".repeat(40), version: "9.9.9", previous_version: "9.9.8", installed_at: "2026-10-07T00:00:00.000Z",
      releases: [{ version: "9.9.9", date: "2026-10-07", notes: "### Added\n- A thing.", summary: { en: { new: ["A thing."] }, ko: { new: ["기능 하나."] } } }], omitted: 0 };
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-installed-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => ({ ...unmanagedUpdateStatus(), managed: true }), notes: () => ({ revision: null, releases: [], omitted: 0 }), installed: () => installed, request() {} } });
    try {
      expect(await (await fetch(`http://localhost:${managed.port}/api/updates/installed`)).json()).toEqual(installed);
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
  });

  it("refuses cross-site/form update requests and unmanaged installs", async () => {
    for (const headers of [{}, { "x-herdr-update": "1", origin: "https://untrusted.invalid" },
      { "x-herdr-update": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(response.status).toBe(409);
    expect((await response.json() as ApiError).error.code).toBe("updates_unmanaged");
  });

  it("installs only the revision the request names, and tells a release that moved later in the status", async () => {
    const offered = "a".repeat(40), moved = "b".repeat(40);
    let status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, latest_revision: offered,
      latest_version: "9.9.9", current_revision: "c".repeat(40), revision_bound_install: true };
    const requests: unknown[] = [];
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-bound-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => status, notes: noUpdateNotes, installed: noInstalledNotes, request: (request) => { requests.push(request); } } });
    const origin = `http://localhost:${managed.port}`;
    const install = (body: string | undefined, headers: Record<string, string> = { "x-herdr-update": "1", "content-type": "application/json" }) =>
      fetch(`${origin}/api/updates/install`, { method: "POST", headers, ...(body === undefined ? {} : { body }) });
    const code = async (response: Response) => ((await response.json()) as ApiError).error.code;
    try {
      // a body that names no full commit, or more than an install's 1 KiB
      for (const body of [undefined, "{}", "not json", JSON.stringify({ expected_revision: "abc" }), JSON.stringify({ expected_revision: offered, pad: "x".repeat(1100) })]) {
        const response = await install(body);
        expect(response.status).toBe(400);
        expect(await code(response)).toBe("invalid_update_install");
      }
      // the same-origin gate comes first, whatever the body
      for (const headers of [{ "content-type": "application/json" }, { "x-herdr-update": "1", origin: "https://untrusted.invalid" }, { "x-herdr-update": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
        expect((await install(JSON.stringify({ expected_revision: offered }), headers)).status).toBe(403);
      }
      // reading the status, as a watching device does, asks for nothing
      expect(((await (await fetch(`${origin}/api/updates`)).json()) as UpdateStatus).revision_bound_install).toBe(true);
      expect(requests).toEqual([]);
      // another release on offer already: refused before the supervisor hears of it
      status = { ...status, latest_revision: moved };
      const stale = await install(JSON.stringify({ expected_revision: offered }));
      expect(stale.status).toBe(409);
      expect(await code(stale)).toBe("update_offer_changed");
      expect(requests).toEqual([]);
      // the offer as shown: accepted, and handed on with its revision
      status = { ...status, latest_revision: offered };
      const accepted = await install(JSON.stringify({ expected_revision: offered }));
      expect(accepted.status).toBe(202);
      // with its own id, which only its 202 tells: a cancel must name it
      const { install_id } = await accepted.json() as { install_id: string };
      expect(requests).toEqual([{ command: "install", expected_revision: offered, install_id }]);
      // a release that moves after the 202 is told by the status, not by the request that finished
      status = { ...status, phase: "error", latest_revision: moved, error_code: "update_offer_changed", error: "A different release is on offer than the one asked for, so nothing was installed. Review it, then update again." };
      expect(await (await fetch(`${origin}/api/updates`)).json()).toMatchObject({ phase: "error", error_code: "update_offer_changed", latest_revision: moved });
      // a supervisor that does not install by revision is sent no install
      status = { ...status, phase: "idle", error: null, error_code: null, revision_bound_install: undefined };
      const older = await install(JSON.stringify({ expected_revision: moved }));
      expect(older.status).toBe(409);
      expect(await code(older)).toBe("update_restart_required");
      // a check stays bodyless
      expect((await fetch(`${origin}/api/updates/check`, { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(202);
      expect(requests).toEqual([{ command: "install", expected_revision: offered, install_id }, { command: "check" }]);
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
  });

  it("keeps status and update actions behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-update-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-update-token" });
    try {
      for (const path of ["/api/updates", "/api/updates/notes", "/api/updates/installed", "/api/updates/check", "/api/updates/install", "/api/updates/cancel"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}${path}`, {
          method: path === "/api/updates/check" || path === "/api/updates/install" || path === "/api/updates/cancel" ? "POST" : "GET", headers: { "x-herdr-update": "1" },
        });
        expect(response.status).toBe(401);
      }
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}/api/herdr/update`, { method, headers: { "x-herdr-update": "1" } });
        expect(response.status).toBe(401);
      }
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });

  it("lets the connection server's bridge token read the update status and install the offer, and nothing else of it", async () => {
    // this PC's own Ovis, gated by its own token, reached by another PC's app through SSH
    const offered = "a".repeat(40);
    const bridge = "b".repeat(64);
    const requests: unknown[] = [];
    const status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, latest_revision: offered, latest_version: "9.9.9", revision_bound_install: true };
    const ownState = mkdtempSync(join(tmpdir(), "herdr-update-bridge-"));
    const own = createServer({ port: 0, stateDir: ownState, token: "own-token", bridgeToken: bridge,
      updates: { status: () => status, notes: noUpdateNotes, installed: noInstalledNotes, request: (request) => { requests.push(request); } } });
    const call = (path: string, authorization: string, body?: string) => fetch(`http://127.0.0.1:${own.port}${path}`, {
      method: body === undefined && path !== "/api/updates/check" ? "GET" : "POST", ...(body === undefined ? {} : { body }),
      headers: { authorization, "x-herdr-update": "1", "content-type": "application/json" },
    });
    try {
      expect(await (await call("/api/updates", `Bearer ${bridge}`)).json()).toMatchObject({ managed: true, available: true, latest_revision: offered });
      // where it answers comes with the status, to the bridge token only: /api/access stays its own token's (#2191)
      const told = await (await call("/api/updates", `Bearer ${bridge}`)).json() as UpdateStatus;
      expect(told.port).toBe(own.port);
      expect(told.serving_url === null || typeof told.serving_url === "string").toBe(true);
      expect((await call("/api/access", `Bearer ${bridge}`)).status).toBe(401);
      const owner = await (await call("/api/updates", "Bearer own-token")).json() as UpdateStatus;
      expect(owner).toMatchObject({ managed: true, latest_revision: offered });
      expect("port" in owner || "serving_url" in owner).toBe(false);
      // the install still names the offer, as from the app's own controls
      expect((await call("/api/updates/install", `Bearer ${bridge}`, "{}")).status).toBe(400);
      expect(requests).toEqual([]);
      const granted = await call("/api/updates/install", `Bearer ${bridge}`, JSON.stringify({ expected_revision: offered }));
      expect(granted.status).toBe(202);
      const { install_id } = await granted.json() as { install_id: string };
      expect(requests).toEqual([{ command: "install", expected_revision: offered, install_id }]);
      // and stop that install while it builds (POST /api/updates/cancel), once its supervisor can
      status.phase = "building";
      expect((await call("/api/updates/cancel", `Bearer ${bridge}`, JSON.stringify({ install_id }))).status).toBe(409);
      status.install_cancellable = true;
      // a cancel that names no install is refused; the one it names is passed on, for the supervisor to stop that one only
      expect((await call("/api/updates/cancel", `Bearer ${bridge}`, "{}")).status).toBe(400);
      expect((await call("/api/updates/cancel", `Bearer ${bridge}`, JSON.stringify({ install_id }))).status).toBe(202);
      expect(requests.at(-1)).toEqual({ command: "cancel", install_id });
      status.phase = "idle";
      requests.splice(1);
      // a wrong bridge token is refused like any other, and the token opens no other update route
      expect((await call("/api/updates", `Bearer ${"c".repeat(64)}`)).status).toBe(401);
      for (const path of ["/api/updates/notes", "/api/updates/installed", "/api/updates/check", "/api/herdr/update"]) expect((await call(path, `Bearer ${bridge}`)).status).toBe(401);
      // only the read and the install it grants, each by its own method and with no query (#2054)
      const send = (method: string, path: string, body?: string) => fetch(`http://127.0.0.1:${own.port}${path}`, {
        method, ...(body === undefined ? {} : { body }), headers: { authorization: `Bearer ${bridge}`, "x-herdr-update": "1", "content-type": "application/json" },
      });
      const install = JSON.stringify({ expected_revision: offered });
      for (const [method, path, body] of [["GET", "/api/updates?anything=1"], ["HEAD", "/api/updates"], ["POST", "/api/updates", install], ["DELETE", "/api/updates"],
        ["GET", "/api/updates/install"], ["PUT", "/api/updates/install", install], ["POST", "/api/updates/install?anything=1", install],
        ["GET", "/api/updates/cancel"], ["POST", "/api/updates/cancel?anything=1", ""]] as const) {
        expect({ method, path, status: (await send(method, path, body)).status }).toEqual({ method, path, status: 401 });
      }
      expect(requests).toHaveLength(1);
    } finally { own.stop(); rmSync(ownState, { recursive: true, force: true }); }
  });

  it("offers no herdr update on a server started without the updater", async () => {
    const response = await fetch(`${base()}/api/herdr/update`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json() as HerdrUpdateStatus).toMatchObject({ supported: false, phase: "idle", output: null });
    expect((await fetch(`${base()}/api/herdr/update`, { method: "POST" })).status).toBe(403);
    const refused = await fetch(`${base()}/api/herdr/update`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as ApiError).error.code).toBe("herdr_update_unsupported");
  });

  it("updates herdr through the server and reports what herdr said", async () => {
    // a stand-in: the real `herdr update` would replace the herdr on PATH and hand its server off
    const state = mkdtempSync(join(tmpdir(), "herdr-update-api-"));
    const standIn = join(state, "herdr");
    writeFileSync(standIn, [
      "#!/bin/sh",
      `echo "$*" >> '${join(state, "calls")}'`,
      'case "$1" in',
      `  status) echo '{"client":{"version":"0.9.3","binary":"${standIn}"},"server":{"running":true,"version":"0.9.3","capabilities":{"live_handoff":true}},"update":{"server_binary_stale":false}}' ;;`,
      "  update) echo 'already up to date (0.9.3)' >&2 ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(standIn, 0o755);
    const server = createServer({ port: 0, stateDir: state, token: "", herdrUpdate: new HerdrUpdater({ bin: standIn }) });
    const url = `http://localhost:${server.port}/api/herdr/update`;
    try {
      expect(await (await fetch(url)).json() as HerdrUpdateStatus).toMatchObject({ supported: true, phase: "idle", server_version: "0.9.3", binary_version: "0.9.3", stale: false });
      expect((await fetch(url, { method: "POST" })).status).toBe(403);
      expect(existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "").not.toContain("update --handoff");
      const accepted = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
      expect(accepted.status).toBe(202);
      const deadline = Date.now() + 10_000;
      let status = await (await fetch(url)).json() as HerdrUpdateStatus;
      while (status.phase === "updating" || status.finished_at === null) {
        if (Date.now() >= deadline) throw new Error("Timed out: the herdr update finished");
        await Bun.sleep(20);
        status = await (await fetch(url)).json() as HerdrUpdateStatus;
      }
      expect(status).toMatchObject({ phase: "idle", output: "already up to date (0.9.3)" });
      expect(readFileSync(join(state, "calls"), "utf8")).toContain("update --handoff");
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("telemetry API", () => {
  it("answers 404 on a server started without telemetry", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base()}/api/telemetry`, { method, headers: { "x-herdr-update": "1", "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status).toBe(404);
      expect((await response.json() as ApiError).error.code).toBe("not_found");
    }
  });

  it("validates real settings payloads, protects acknowledgement, and previews only safe event values", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-telemetry-api-"));
    const sent: TelemetryEvent[] = [];
    const telemetry = new Telemetry({ stateDir: state, version: "9.9.9", env: {}, url: "http://receiver.invalid/v1/events", noticeGraceMs: 0,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)) as TelemetryEvent); return new Response(null, { status: 204 }); }) as typeof fetch });
    const server = createServer({ port: 0, stateDir: state, token: "", telemetry });
    const url = `http://localhost:${server.port}/api/telemetry`;
    const headers = { "content-type": "application/json", "x-herdr-update": "1", origin: new URL(url).origin };
    const settings = telemetrySettingsSnapshot({
      ...DEFAULT_SETTINGS,
      theme: "light",
      terminalFontFamily: "private font name",
      quickReplies: ["private reply"],
      usageHidden: ["private-account-key"],
    });
    try {
      const first = await fetch(url);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json() as TelemetryStatus).toMatchObject({ enabled: true, notice_seen: false, blocked_by_env: false, next: { event: "install", version: "9.9.9", settings: null } });

      const post = (body: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
        method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
      });
      expect((await post({ notice_seen: true, notice_version: NOTICE_VERSION }, { "x-herdr-update": "" })).status).toBe(403);
      expect((await post({ notice_seen: true, notice_version: NOTICE_VERSION }, { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post({ notice_seen: true })).status).toBe(400);
      expect((await post({ notice_seen: true, notice_version: NOTICE_VERSION - 1 })).status).toBe(400);
      expect((await post({ settings: { ...settings, theme: "private text" } })).status).toBe(400);
      expect((await post({ settings: { ...settings, injected: true } })).status).toBe(400);
      expect((await post({ settings, changed_settings: ["theme"] })).status).toBe(400);
      expect(await (await fetch(url)).json() as TelemetryStatus).toMatchObject({ notice_seen: false, next: { settings: null } });
      expect(sent).toEqual([]);

      const seen = await post({ notice_seen: true, notice_version: NOTICE_VERSION, settings });
      const preview = await seen.json() as TelemetryStatus;
      expect(seen.status).toBe(200);
      expect(preview).toMatchObject({ notice_seen: true, next: { event: "install", settings } });
      expect(JSON.stringify(preview)).not.toContain("private font name");
      expect(JSON.stringify(preview)).not.toContain("private reply");
      expect(JSON.stringify(preview)).not.toContain("private-account-key");
      await telemetry.report();
      expect(sent).toEqual([expect.objectContaining({ event: "install", version: "9.9.9", settings })]);
      expect(JSON.stringify(sent[0]!.settings)).not.toContain("private font name");
      expect(JSON.stringify(sent[0]!.settings)).not.toContain("private reply");
      expect(JSON.stringify(sent[0]!.settings)).not.toContain("private-account-key");
      expect(await (await fetch(url)).json() as TelemetryStatus).toMatchObject({ next: null });
      const off = await post({ enabled: false });
      expect(await off.json() as TelemetryStatus).toMatchObject({ enabled: false });
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });

  it("counts a browser's websocket visit as one active message naming only allowed harness kinds", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-telemetry-active-"));
    const posts: { url: string; body: TelemetryActive }[] = [];
    let firstPost!: () => void;
    const arrived = new Promise<void>((resolve) => { firstPost = resolve; });
    const telemetry = new Telemetry({ stateDir: state, version: "9.9.9", env: {}, url: "http://receiver.invalid/v1/events", activeUrl: "http://receiver.invalid/v1/active", noticeGraceMs: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)) as TelemetryActive });
        if (String(url).endsWith("/v1/active")) firstPost();
        return new Response(null, { status: 204 });
      }) as typeof fetch });
    const server = createServer({ port: 0, stateDir: state, token: "", telemetry });
    const url = `http://localhost:${server.port}/api/telemetry`;
    const headers = { "content-type": "application/json", "x-herdr-update": "1", origin: new URL(url).origin };
    const sockets: WebSocket[] = [];
    const snapshot = (): Promise<void> => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error("no snapshot frame")), 10_000);
      socket.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
      socket.onmessage = (event) => {
        if ((JSON.parse(String(event.data)) as { type: string }).type !== "snapshot") return;
        clearTimeout(timer);
        resolve();
      };
    });
    try {
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ notice_seen: true, notice_version: NOTICE_VERSION }) })).status).toBe(200);
      await snapshot();
      await Promise.race([arrived, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no active message")), 10_000))]);
      const active = posts.filter((post) => post.url.endsWith("/v1/active"));
      expect(active).toHaveLength(1);
      expect(active[0]!.body.event).toBe("active");
      expect(telemetryHarnesses(active[0]!.body.harnesses)).toEqual(active[0]!.body.harnesses);
      expect((await (await fetch(url)).json() as TelemetryStatus).active.harnesses).toEqual(active[0]!.body.harnesses);
      await snapshot();
      await telemetry.active([]);
      expect(posts.filter((post) => post.url.endsWith("/v1/active"))).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.close();
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("keeps telemetry behind the token gate", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-telemetry-auth-"));
    const telemetry = new Telemetry({ stateDir: state, version: "9.9.9", env: {}, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    const server = createServer({ port: 0, stateDir: state, token: "test-telemetry-token", telemetry });
    try {
      for (const method of ["GET", "POST"]) {
        expect((await fetch(`http://localhost:${server.port}/api/telemetry`, { method, headers: { "x-herdr-update": "1" } })).status).toBe(401);
      }
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("phone access", () => {
  it("says how a phone can reach this server, whatever Tailscale is doing on this machine", async () => {
    const response = await fetch(`${base()}/api/access`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const access = (await response.json()) as RemoteAccess;
    expect(access.port).toBe(server.port);
    expect(["missing", "stopped", "running"]).toContain(access.tailscale.state);
    if (access.tailscale.state !== "running") {
      expect(access.tailscale).toEqual({ state: access.tailscale.state, dns_name: null, serving_url: null, serve_command: null, serve_url: null });
    } else {
      // either an address already works, or there is a command to make one
      expect((access.tailscale.serving_url === null) !== (access.tailscale.serve_command === null)).toBe(true);
      if (access.tailscale.serve_command !== null) expect(access.tailscale.serve_command).toContain(`http://127.0.0.1:${server.port}`);
    }
  });

  it("stays behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-access-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-access-token" });
    try {
      expect((await fetch(`http://localhost:${protectedServer.port}/api/access`)).status).toBe(401);
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });
});

describe("herdr's selection preference", () => {
  it("answers this PC's herdr copy_on_select, read again on each request, uncached and behind the token gate", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-route-"));
    const configPath = join(state, "config.toml");
    writeFileSync(configPath, "[ui]\ncopy_on_select = false\n");
    const gated = createServer({ port: 0, stateDir: state, token: "test-herdr-ui-token", herdrConfigPath: configPath });
    try {
      const url = `http://localhost:${gated.port}/api/herdr-ui`;
      expect((await fetch(url)).status).toBe(401);
      const headers = { authorization: "Bearer test-herdr-ui-token" };
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ copy_on_select: false, keys: { prefix: "ctrl+b" } });
      writeFileSync(configPath, "[ui]\ncopy_on_select = true\n[keys]\nprefix = \"ctrl+a\"\n");
      expect(await (await fetch(url, { headers })).json()).toMatchObject({ copy_on_select: true, keys: { prefix: "ctrl+a", prefixes: ["ctrl+a"] } });
      expect((await fetch(url, { method: "POST", headers: { ...headers, origin: `http://localhost:${gated.port}` } })).status).toBe(400);
    } finally { gated.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("Portal API", () => {
  it("does not serve requests until startup cleanup completes", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-startup-gate-"));
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    class DeferredPortal extends PortalService {
      override resume(): Promise<void> { return cleanup; }
    }
    const server = createServer({ port: 0, stateDir: state, token: "", portal: new DeferredPortal({ stateDir: state }) });
    try {
      let resolved = false;
      const request = fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`).then((response) => {
        resolved = true;
        return response;
      });
      const deadline = Date.now() + 50;
      while (!resolved && Date.now() < deadline) await Bun.sleep(5);
      expect(resolved).toBe(false);
      releaseCleanup();
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, bridge_protocol: expect.any(Number) });
    } finally {
      releaseCleanup();
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("fails closed when startup cleanup rejects", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-startup-failure-"));
    class FailedPortal extends PortalService {
      override resume(): Promise<void> { return Promise.reject(new Error("Portal cleanup failed")); }
    }
    const server = createServer({ port: 0, stateDir: state, token: "", portal: new FailedPortal({ stateDir: state }) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    } finally {
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("opens a public address only behind the token, and closes it again", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-api-"));
    const standIn = join(state, "stand-in-portal");
    writeFileSync(standIn, [
      "#!/bin/sh",
      'case "$1" in',
      "  version) echo v2.6.1 ;;",
      "  expose) [ \"$2\" = --help ] && exit 0; trap 'exit 0' TERM; echo 'INF service ready at https://herdr-test-0123.relay.example:443'; while :; do sleep 0.05; done ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(standIn, 0o755);
    const relay = (async () => Response.json({ data: { release_version: "v2.6.1" } })) as unknown as typeof fetch;
    const server = createServer({ port: 0, stateDir: state, token: "test-portal-token", portal: new PortalService({ stateDir: state, bin: standIn, fetch: relay }) });
    const url = `http://127.0.0.1:${server.port}/api/portal`;
    const signedIn = { authorization: "Bearer test-portal-token" };
    const post = (action: string, headers: Record<string, string>) => fetch(`${url}/${action}`, { method: "POST", headers: { ...headers, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ relay: "relay.example" }) });
    const status = async (headers: Record<string, string> = signedIn) => await (await fetch(url, { headers })).json() as PortalStatus;
    try {
      expect((await fetch(url)).status).toBe(401);
      expect(await status()).toMatchObject({ supported: true, usable: true, blocked: null, phase: "idle" });
      expect((await post("start", {})).status).toBe(401);
      expect((await post("invite", {})).status).toBe(401);
      expect((await post("start", signedIn)).status).toBe(202);
      const deadline = Date.now() + 10_000;
      let running = await status();
      while (running.phase === "starting") {
        if (Date.now() >= deadline) throw new Error("Timed out: Portal was ready");
        await Bun.sleep(20);
        running = await status();
      }
      expect(running).toMatchObject({ phase: "running", url: "https://herdr-test-0123.relay.example", relay: "https://relay.example" });
      expect((await post("stop", signedIn)).status).toBe(202);
      expect((await status()).url).toBeNull();
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("mutation body validation", () => {
  it("rejects non-object JSON without touching herdr or losing the error envelope", async () => {
    for (const path of [
      "/api/workspace/create", "/api/tab/create", "/api/tab/rename", "/api/tab/close", "/api/tab/move", "/api/tab/move-to-workspace", "/api/workspace/rename", "/api/workspace/move", "/api/workspace/close",
      "/api/pane/rename", "/api/pane/input", "/api/pane/keys", "/api/pane/close", "/api/pane/image",
      "/api/pane/scroll", "/api/agent/rename",
    ]) {
      for (const body of [null, [], "text", 42, true]) {
        const response = await fetch(`${base()}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error.code).toBe("invalid_body");
      }
    }
  });

  it("rejects invalid pane identifiers and key/image fields before RPCs", async () => {
    for (const [path, body, code] of [
      ["/api/pane/input", { pane_id: true, text: "echo bad" }, "missing_pane_id"],
      ["/api/pane/close", { pane_id: 5 }, "missing_pane_id"],
      ["/api/pane/keys", { pane_id: "unknown", keys: [null] }, "missing_keys"],
      ["/api/pane/image", { pane_id: "unknown", content_type: "image/png", data_base64: {} }, "invalid_image"],
      ["/api/workspace/create", { agent: { kind: "claude", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const response = await fetch(`${base()}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
  });
});

// herdr's prefix+shift+t and prefix+shift+x, against a real herdr.
describe("tab rename and close", () => {
  const post = (path: string, body: unknown) => fetch(`${base()}/api/tab/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const tabsOf = async (workspaceId: string) => (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.tabs.filter((t) => t.workspace_id === workspaceId);

  it("validates the tab and the label before touching herdr", async () => {
    for (const path of ["rename", "close"]) {
      for (const tab_id of [undefined, null, "", 1, true]) {
        const res = await post(path, { tab_id, label: "name" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiError).error.code).toBe("missing_tab_id");
      }
      expect((await fetch(`${base()}/api/tab/${path}`)).status).toBe(400);
      const missing = await post(path, { tab_id: "unknown:t9", label: "name" });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as ApiError).error.code).toBe("tab_not_found");
    }
    // herdr would keep an empty label as the tab's name
    for (const label of [undefined, null, "", "   ", 3]) {
      const res = await post("rename", { tab_id: "unknown:t9", label });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("missing_label");
    }
    const long = await post("rename", { tab_id: "unknown:t9", label: "T".repeat(81) });
    expect(long.status).toBe(400);
    expect(((await long.json()) as ApiError).error.code).toBe("label_too_long");
  });

  it("renames a tab, closes one beside another, and takes the workspace with its last tab", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-rename-close" });
    const id = owned.workspace.workspace_id;
    let closed = false;
    try {
      const second = await tabCreate({ workspaceId: id });
      const renamed = await post("rename", { tab_id: second.tab.tab_id, label: "  build  " });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ ok: true });
      expect((await tabsOf(id)).find((t) => t.tab_id === second.tab.tab_id)?.label).toBe("build");
      // the local-PC alias reaches both
      const alias = await fetch(`${base()}/api/machines/local/tab/rename`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ tab_id: second.tab.tab_id, label: "tests" }),
      });
      expect(alias.status).toBe(200);
      expect((await tabsOf(id)).find((t) => t.tab_id === second.tab.tab_id)?.label).toBe("tests");

      expect((await post("close", { tab_id: owned.tab.tab_id })).status).toBe(200);
      const left = await tabsOf(id);
      expect(left.map((t) => t.tab_id)).toEqual([second.tab.tab_id]);
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(snapshot.panes.some((p) => p.pane_id === owned.root_pane.pane_id)).toBe(false);
      expect(snapshot.panes.some((p) => p.pane_id === second.root_pane.pane_id)).toBe(true);

      expect((await post("close", { tab_id: second.tab.tab_id })).status).toBe(200);
      closed = !(await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.workspaces.some((w) => w.workspace_id === id);
      expect(closed).toBe(true);
    } finally { if (!closed) await workspaceClose(id); }
  });
});

describe("tab reorder", () => {
  const post = (body: unknown, path = "/api/tab/move") => fetch(`${base()}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body),
  });
  it("requires a tab and a non-negative safe insertion boundary", async () => {
    expect((await fetch(`${base()}/api/tab/move`)).status).toBe(400);
    for (const tab_id of [undefined, null, "", 4, true]) {
      const result = await post({ tab_id, insert_index: 0 });
      expect(result.status).toBe(400);
      expect(((await result.json()) as ApiError).error.code).toBe("missing_tab_id");
    }
    for (const insert_index of [undefined, null, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      const result = await post({ tab_id: "unknown:t9", insert_index });
      expect(result.status).toBe(400);
      expect(((await result.json()) as ApiError).error.code).toBe("invalid_index");
    }
    const missing = await post({ tab_id: "unknown:t9", insert_index: 0 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("tab_not_found");
  });
  it("uses boundaries before removal, preserves focus and IDs, and rejects out-of-range moves", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-reorder" });
    const id = owned.workspace.workspace_id;
    try {
      const second = await tabCreate({ workspaceId: id, label: "build" });
      const third = await tabCreate({ workspaceId: id });
      const firstId = owned.tab.tab_id;
      const initial = await sessionSnapshot();
      const nativeIds = () => sessionSnapshot().then((snapshot) => snapshot.tabs.filter((tab) => tab.workspace_id === id).map((tab) => tab.tab_id));
      for (const [boundary, expected] of [[3, [second.tab.tab_id, third.tab.tab_id, firstId]], [0, [firstId, second.tab.tab_id, third.tab.tab_id]]] as const) {
        const response = await post({ tab_id: firstId, insert_index: boundary }, "/api/machines/local/tab/move");
        expect(response.status).toBe(200);
        const result = await response.json() as TabMoved;
        expect(result.ok).toBe(true);
        expect(result.tabs.map((tab) => tab.tab_id)).toEqual([...expected]);
        expect(result.tabs.find((tab) => tab.tab_id === second.tab.tab_id)?.label).toBe("build");
        expect(await nativeIds()).toEqual([...expected]);
        const snapshot = await sessionSnapshot();
        expect(snapshot.focused_pane_id).toBe(initial.focused_pane_id);
        expect(snapshot.focused_tab_id).toBe(initial.focused_tab_id);
        expect(snapshot.panes.filter((pane) => pane.workspace_id === id).map((pane) => pane.pane_id).sort()).toEqual(initial.panes.filter((pane) => pane.workspace_id === id).map((pane) => pane.pane_id).sort());
      }
      const bad = await post({ tab_id: firstId, insert_index: 4 });
      expect(bad.status).toBe(404);
      expect(((await bad.json()) as ApiError).error.code).toBe("tab_move_failed");
      expect(await nativeIds()).toEqual([firstId, second.tab.tab_id, third.tab.tab_id]);
      // Either boundary touching the source is a no-op, not a close/recreate.
      expect((await post({ tab_id: firstId, insert_index: 1 })).status).toBe(200);
      expect(await nativeIds()).toEqual([firstId, second.tab.tab_id, third.tab.tab_id]);
    } finally { await workspaceClose(id); }
  });
});

describe("tab to another workspace", () => {
  const post = (body: unknown) => fetch(`${base()}/api/machines/local/tab/move-to-workspace`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body),
  });
  it("requires a tab and a workspace", async () => {
    for (const [body, code] of [[{ workspace_id: "w1" }, "missing_tab_id"], [{ tab_id: "w1:t1", workspace_id: "" }, "missing_workspace_id"]] as const) {
      const result = await post(body);
      expect(result.status).toBe(400);
      expect(((await result.json()) as ApiError).error.code).toBe(code);
    }
    const missing = await post({ tab_id: "unknown:t9", workspace_id: "w1" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("tab_not_found");
  });
  it("moves a one-pane tab with its label and process, and refuses a split tab", async () => {
    const source = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-out" });
    const target = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-in" });
    const open = [source.workspace.workspace_id, target.workspace.workspace_id];
    try {
      const named = await tabCreate({ workspaceId: source.workspace.workspace_id, label: "build" });
      await paneSplit(source.root_pane.pane_id, "right", false);
      const split = await post({ tab_id: source.tab.tab_id, workspace_id: target.workspace.workspace_id });
      expect(split.status).toBe(409);
      expect(((await split.json()) as ApiError).error.code).toBe("multi_pane_tab");
      const same = await post({ tab_id: named.tab.tab_id, workspace_id: source.workspace.workspace_id });
      expect(((await same.json()) as ApiError).error.code).toBe("same_workspace");

      const response = await post({ tab_id: named.tab.tab_id, workspace_id: target.workspace.workspace_id });
      expect(response.status).toBe(200);
      const moved = await response.json() as TabMovedToWorkspace;
      const snapshot = await sessionSnapshot();
      const pane = snapshot.panes.find((candidate) => candidate.pane_id === moved.pane_id);
      expect(pane?.workspace_id).toBe(target.workspace.workspace_id);
      expect(snapshot.tabs.find((tab) => tab.tab_id === moved.tab_id)?.label).toBe("build");
      expect(snapshot.tabs.some((tab) => tab.tab_id === named.tab.tab_id)).toBe(false);
      expect(snapshot.panes.some((candidate) => candidate.pane_id === named.root_pane.pane_id)).toBe(false);
    } finally { for (const id of open) await workspaceClose(id).catch(() => {}); }
  });
  it("leaves the name herdr gave a tab by its place behind, though the tab's number differs", async () => {
    const source = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-place-out" });
    const target = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-place-in" });
    const open = [source.workspace.workspace_id, target.workspace.workspace_id];
    try {
      await tabCreate({ workspaceId: source.workspace.workspace_id });
      const third = await tabCreate({ workspaceId: source.workspace.workspace_id });
      await tabCreate({ workspaceId: target.workspace.workspace_id });
      // the first tab closes: the third keeps its number, and herdr names it by its new place
      await herdrRpc("tab.close", { tab_id: source.tab.tab_id });
      const before = (await sessionSnapshot()).tabs.find((tab) => tab.tab_id === third.tab.tab_id);
      expect(before?.number).toBe(3);
      expect(before?.label).toBe("2");
      const response = await post({ tab_id: third.tab.tab_id, workspace_id: target.workspace.workspace_id });
      expect(response.status).toBe(200);
      const moved = await response.json() as TabMovedToWorkspace;
      const row = (await sessionSnapshot()).tabs.filter((tab) => tab.workspace_id === target.workspace.workspace_id);
      // third in its new row, and unnamed there: herdr names it by that place, not by the "2" it had
      expect(row.map((tab) => tab.tab_id).indexOf(moved.tab_id)).toBe(2);
      expect(row.find((tab) => tab.tab_id === moved.tab_id)?.label).toBe("3");
    } finally { for (const id of open) await workspaceClose(id).catch(() => {}); }
  });
});

describe("agent rename", () => {
  const post = (body: unknown) => fetch(`${base()}/api/agent/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nameOf = async (paneId: string): Promise<string | null> =>
    (await herdrRpc<{ agents: Array<{ pane_id: string; name?: string | null }> }>("agent.list", {})).agents.find((agent) => agent.pane_id === paneId)?.name ?? null;

  it("sets, reads back and clears a pane's agent name, and passes herdr's refusals through", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-agent-rename" });
    const id = owned.workspace.workspace_id;
    const paneId = owned.root_pane.pane_id;
    try {
      // a shell pane has no live agent to name
      const shell = await post({ pane_id: paneId, name: "webui-rename-a" });
      expect(shell.status).toBe(404);
      expect(((await shell.json()) as ApiError).error.code).toBe("agent_not_found");

      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "ovis-test", agent: "claude", state: "idle" });
      const set = await post({ pane_id: paneId, name: "webui-rename-a" });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBe("webui-rename-a");
      // the browser reads it off the session snapshot's agents
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      expect(session.snapshot.agents.find((agent) => agent.pane_id === paneId)?.name).toBe("webui-rename-a");

      // herdr's rule, in herdr's words, and the name stays
      const invalid = await post({ pane_id: paneId, name: "Bad Name" });
      expect(invalid.status).toBe(404);
      const refused = (await invalid.json()) as ApiError;
      expect(refused.error.code).toBe("invalid_agent_name");
      expect(refused.error.message).toContain("lowercase");
      expect(await nameOf(paneId)).toBe("webui-rename-a");

      // unique among the session's live agents
      const second = await tabCreate({ workspaceId: id });
      await herdrRpc("pane.report_agent", { pane_id: second.root_pane.pane_id, source: "ovis-test", agent: "codex", state: "working" });
      const taken = await post({ pane_id: second.root_pane.pane_id, name: "webui-rename-a" });
      expect(taken.status).toBe(404);
      expect(((await taken.json()) as ApiError).error.code).toBe("agent_name_taken");
      expect(await nameOf(second.root_pane.pane_id)).toBeNull();

      // the local-PC alias reaches it, and null clears
      const alias = await fetch(`${base()}/api/machines/local/agent/rename`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ pane_id: paneId, name: null }),
      });
      expect(alias.status).toBe(200);
      expect(await alias.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBeNull();
    } finally { await workspaceClose(id); }
  });

  it("forwards a remote rename with the registered bridge token, not the browser's", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-agent-rename-bridge" });
    const paneId = owned.root_pane.pane_id;
    const state = mkdtempSync(join(tmpdir(), "ovis-agent-rename-bridge-"));
    // the other PC's bridge asks its browsers for a token of its own; the proxy holds only the bridge token it registered
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: state, tailscaleOwner: null });
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const manager = { endpoint: (id: string) => id === "rename-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    try {
      expect(registered.token).not.toBe("test-browser-token");
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "ovis-test", agent: "claude", state: "idle" });
      // the browser token is deliberately absent: the proxy must authenticate with the bridge token
      expect((await fetch(`${endpoint}/api/agent/rename`, { method: "POST", body: "{}" })).status).toBe(401);
      const res = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/rename-remote/agent/rename", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ pane_id: paneId, name: "webui-rename-b" }),
      }), manager);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBe("webui-rename-b");
    } finally {
      bridge.stop();
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("answers the new-tab dialog's agent commands to another PC's registered bridge token", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-agent-commands-bridge-"));
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: state, tailscaleOwner: null });
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const manager = { endpoint: (id: string) => id === "commands-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    try {
      expect((await fetch(`${endpoint}/api/agent/commands?agent=claude`)).status).toBe(401);
      const res = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/commands-remote/agent/commands?agent=claude", { headers: { origin: "http://127.0.0.1" } }), manager);
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { commands: unknown[] }).commands)).toBeTrue();
    } finally {
      bridge.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  // #2044: a crash left machines.json its old length in NULs, and the server would not start
  it("starts on saved PCs that are not JSON and names the file it set aside in the PC settings, read only", async () => {
    const state = mkdtempSync(join(tmpdir(), "ovis-machines-set-aside-"));
    writeFileSync(join(state, "machines.json"), Buffer.alloc(353));
    const error = spyOn(console, "error").mockImplementation(() => {});
    let app: ReturnType<typeof createServer> | undefined;
    try {
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, tailscaleOwner: null });
      const url = `http://127.0.0.1:${app.port}/api/machines/settings`;
      const settings = await (await fetch(url)).json() as MachineSettings;
      expect(settings).toEqual({ auto_update_bridges: true, set_aside: [expect.stringMatching(/^machines\.json\.corrupt-\S+$/)] });
      expect(readdirSync(state)).toContain(settings.set_aside![0]!);
      const patched = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1" }, body: JSON.stringify({ auto_update_bridges: false, set_aside: [] }) });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toEqual({ auto_update_bridges: false, set_aside: settings.set_aside });
    } finally {
      app?.stop(); error.mockRestore();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("validates the body before asking herdr", async () => {
    for (const [body, code] of [
      [{}, "missing_pane_id"],
      [{ pane_id: "", name: "x" }, "missing_pane_id"],
      // an omitted name is not a clear: only null is
      [{ pane_id: "w1:p1" }, "invalid_name"],
      [{ pane_id: "w1:p1", name: 42 }, "invalid_name"],
    ] as const) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/agent/rename`)).status).toBe(400);
  });
});

// Tab creation shares workspace creation's agent launch (#362 by @WOULDU-pres): the cases
// below prove the tab half of that path against a real herdr.
describe("tab creation", () => {
  const post = (body: unknown) => fetch(`${base()}/api/tab/create`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("requires an explicit workspace and validates fields before creating a tab", async () => {
    for (const workspace_id of [undefined, null, "", " ", 1, true]) {
      const res = await post({ workspace_id });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("missing_workspace_id");
    }
    for (const [fields, code] of [
      [{ cwd: join(tmpdir(), crypto.randomUUID()) }, "invalid_cwd"],
      [{ cwd: 42 }, "invalid_cwd"],
      [{ label: false }, "missing_label"],
      [{ label: "T".repeat(81) }, "label_too_long"],
      [{ agent: {} }, "invalid_agent"],
      [{ agent: { kind: "muse", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const res = await post({ workspace_id: "unknown", ...fields });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/tab/create`)).status).toBe(400);
    const missing = await post({ workspace_id: "unknown" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.message.length).toBeGreaterThan(0);
  });

  it("creates a sibling tab with its own cwd and label without adding a workspace", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab" });
    const cwd = mkdtempSync(join(tmpdir(), "ovis-tab-cwd-"));
    try {
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      const res = await post({ workspace_id: owned.workspace.workspace_id, cwd, label: "second tab", agent: null });
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);
      const after = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(after.workspaces.map((w) => w.workspace_id)).toEqual(before.workspaces.map((w) => w.workspace_id));
      const pane = after.panes.find((p) => p.pane_id === created.pane_id)!;
      expect(pane.workspace_id).toBe(owned.workspace.workspace_id);
      expect(pane.cwd).toBe(cwd);
      expect(pane.tab_id).not.toBe(owned.tab.tab_id);
      expect(after.tabs.find((t) => t.tab_id === pane.tab_id)?.label).toBe("second tab");
      expect(after.workspaces.find((w) => w.workspace_id === owned.workspace.workspace_id)?.tab_count).toBe(2);
      expect(after.workspaces.find((w) => w.workspace_id === owned.workspace.workspace_id)?.label).toBe(owned.workspace.label);
      // the dialog sends null for "not given": herdr then uses the workspace's folder and the tab's number
      const defaults = await post({ workspace_id: owned.workspace.workspace_id, cwd: null, label: null, agent: null });
      expect(defaults.status).toBe(200);
      const third = await defaults.json() as WorkspaceCreated;
      expect(third).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      const last = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      const thirdPane = last.panes.find((p) => p.pane_id === third.pane_id)!;
      expect(thirdPane.cwd).toBe(owned.root_pane.cwd);
      expect(last.tabs.find((t) => t.tab_id === thirdPane.tab_id)).toMatchObject({ label: "3", number: 3 });
    } finally {
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports the authenticated local-PC alias without allowing other tab routes", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-local-alias" });
    try {
      const res = await fetch(`${base()}/api/machines/local/tab/create`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ workspace_id: owned.workspace.workspace_id, agent: null }),
      });
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);
      expect((await fetch(`${base()}/api/machines/local/tab/move/extra`)).status).toBe(404);
    } finally { await workspaceClose(owned.workspace.workspace_id); }
  });

  it("forwards remote tab creation using the registered bridge token", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-bridge" });
    const state = mkdtempSync(join(tmpdir(), "ovis-tab-bridge-"));
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: state, tailscaleOwner: null });
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const manager = { endpoint: (id: string) => id === "tab-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    try {
      const request = () => new Request("http://127.0.0.1/api/machines/tab-remote/tab/create", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ workspace_id: owned.workspace.workspace_id, cwd: tmpdir(), agent: null }),
      });
      // The browser token is deliberately absent: the proxy must authenticate with the bridge token.
      expect((await fetch(`${endpoint}/api/tab/create`, { method: "POST", body: "{}" })).status).toBe(401);
      const res = await handleMachineRequest(request(), manager);
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);

      const createdTab = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === created.pane_id)!.tab_id;
      const moved = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/tab-remote/tab/move", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ tab_id: createdTab, insert_index: 0 }),
      }), manager);
      expect(moved?.status).toBe(200);
      expect(((await moved!.json()) as TabMoved).tabs[0]?.tab_id).toBe(createdTab);
      const management = await fetch(`${endpoint}/api/machines`, { headers: { authorization: `Bearer ${registered.token}` } });
      expect(management.status).toBe(401);
    } finally {
      bridge.stop();
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("shares unique agent names across concurrent tabs and preserves a tab when an explicit name collides", async () => {
    const first = await fetch(`${base()}/api/workspace/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), label: "ovis-test-tab-agents", agent: { kind: "muse" } }),
    });
    const owned = await first.json() as WorkspaceCreated;
    const nameOf = async (paneId: string) => (await herdrRpc<{ agent: { name: string } }>("agent.get", { target: paneId })).agent.name;
    try {
      expect(owned.agent_started).toBeTrue();
      const names = [await nameOf(owned.pane_id)];
      const tabs = await Promise.all([post({ workspace_id: owned.workspace_id, agent: { kind: "muse" } }), post({ workspace_id: owned.workspace_id, agent: { kind: "muse" } })]);
      for (const res of tabs) {
        expect(res.status).toBe(200);
        const tab = await res.json() as WorkspaceCreated;
        expect(tab).toMatchObject({ workspace_id: owned.workspace_id, agent_started: true });
        expect(tab.error).toBeUndefined();
        names.push(await nameOf(tab.pane_id));
      }
      expect(new Set(names).size).toBe(3);
      const collision = await post({ workspace_id: owned.workspace_id, agent: { kind: "muse", name: names[0] } });
      const failed = await collision.json() as WorkspaceCreated;
      expect(collision.status).toBe(200);
      expect(failed).toMatchObject({ workspace_id: owned.workspace_id, agent_started: false, error: { code: "agent_name_taken" } });
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(snapshot.panes.some((p) => p.pane_id === failed.pane_id && p.workspace_id === owned.workspace_id)).toBeTrue();
      expect(snapshot.workspaces.find((w) => w.workspace_id === owned.workspace_id)?.tab_count).toBe(4);
    } finally { await workspaceClose(owned.workspace_id); }
  }, 20_000);

  it("refuses a first message without an agent, an empty, oversized or control-laden one, before anything is made", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-first-message" });
    try {
      const before = (await sessionSnapshot()).tabs.length;
      for (const [body, reason] of [
        [{ workspace_id: owned.workspace.workspace_id, agent: null, first_message: "a shell takes no message" }, "no agent"],
        [{ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" }, first_message: "   " }, "blank"],
        [{ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" }, first_message: "x".repeat(20_001) }, "too long"],
        [{ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" }, first_message: "run \u001b[2J this" }, "control characters"],
        [{ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" }, first_message: 42 }, "not a string"],
      ] as const) {
        const res = await post(body);
        expect(res.status, reason).toBe(400);
        expect(((await res.json()) as ApiError).error.code, reason).toBe("invalid_first_message");
      }
      expect((await sessionSnapshot()).tabs.length).toBe(before);
    } finally {
      await workspaceClose(owned.workspace.workspace_id);
    }
  });

  it("refuses launch arguments the dialog never sends, before anything is made: a tab or line break, a model of two words, an effort the agent does not name", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-launch-args" });
    try {
      const before = (await sessionSnapshot()).tabs.length;
      for (const [agent, reason] of [
        [{ kind: "codex", args: ["--", "run\tthis"] }, "a tab in Codex's prompt"],
        [{ kind: "codex", args: ["--", "first\nsecond"] }, "a line break in Codex's prompt"],
        [{ kind: "claude", args: ["--model", "two words"] }, "a model of two words"],
        [{ kind: "claude", args: ["--effort", "ultra"] }, "an effort Claude Code does not name"],
        [{ kind: "codex", args: ["-c", "model_reasoning_effort=ultracode"] }, "an effort Codex does not name"],
      ] as const) {
        const res = await post({ workspace_id: owned.workspace.workspace_id, agent });
        expect(res.status, reason).toBe(400);
        expect(((await res.json()) as ApiError).error.code, reason).toBe("invalid_agent");
      }
      expect((await sessionSnapshot()).tabs.length).toBe(before);
    } finally {
      await workspaceClose(owned.workspace.workspace_id);
    }
  });

  it("returns the created tab when a shell agent is unavailable, and queues no first message for an agent that did not start", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-shell" });
    const bin = mkdtempSync(join(tmpdir(), "ovis-tab-empty-path-"));
    const path = process.env["PATH"];
    try {
      process.env["PATH"] = bin;
      const res = await post({ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" }, first_message: "Plan the config file" });
      const failed = await res.json() as WorkspaceCreated;
      expect(res.status).toBe(200);
      expect(failed).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false, error: { code: "agent_start_failed" }, first_message: null });
      expect(failed.error?.message).toContain("gjc is not on this server's PATH");
      expect(failed.pane_id).not.toBe(owned.root_pane.pane_id);
    } finally {
      process.env["PATH"] = path;
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("says when the agent started but its first message could not be queued, apart from an agent that did not start", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-tab-first-not-queued" });
    const made: string[] = [];
    // the queue's own refusals, past the route's checks: its text rule, and a full list
    const text = spyOn(PendingInputs.prototype, "enqueue").mockImplementation(() => { throw new HerdrError("invalid_submit_text", "refused by the queue"); });
    try {
      const res = await post({ workspace_id: owned.workspace.workspace_id, agent: { kind: "muse" }, first_message: "Plan the config file" });
      expect(res.status).toBe(200);
      const tab = await res.json() as WorkspaceCreated;
      expect(tab).toMatchObject({ agent_started: true, first_message: { error: { code: "invalid_submit_text", message: "refused by the queue" } } });
      expect(tab.error).toBeUndefined();
    } finally { text.mockRestore(); }
    const enqueue = spyOn(PendingInputs.prototype, "enqueue").mockImplementation(() => { throw new PendingInputError("pending_limit", "the list is full"); });
    try {
      const res = await fetch(`${base()}/api/workspace/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: tmpdir(), label: "ovis-test-ws-first-not-queued", agent: { kind: "muse" }, first_message: "Plan the config file" }) });
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      made.push(created.workspace_id);
      expect(created).toMatchObject({ agent_started: true, first_message: { error: { code: "pending_limit", message: "the list is full" } } });
    } finally {
      enqueue.mockRestore();
      await workspaceClose(owned.workspace.workspace_id);
      for (const id of made) await workspaceClose(id);
    }
  }, 30_000);
});

describe("workspace and discovery endpoints", () => {
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  const label = `ovis-test-${Math.random().toString(36).slice(2)}`;
  const fileName = `${label}-mention.txt`;
  const filePath = join(tmpdir(), fileName);

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    rmSync(filePath, { force: true });
  });

  it("lists agent kinds with required fallbacks sorted by display label", async () => {
    const res = await fetch(`${base()}/api/agents`);
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: AgentKind[] };
    expect(agents.some((agent) => agent.kind === "claude")).toBeTrue();
    expect(agents.some((agent) => agent.kind === "omp")).toBeTrue();
    // omo and gjc are listed only where this server finds them on PATH, so only listed kinds are checked
    expect(agents.filter((agent) => SUPPORTED_AGENT_KINDS.has(agent.kind) && agent.kind !== "pi" && agent.label === agent.kind).map((agent) => agent.kind)).toEqual([]);
    expect(agents.find((agent) => agent.kind === "hermes")?.label).toBe("Hermes");
    expect(agents.map((agent) => agent.label)).toEqual([...agents.map((agent) => agent.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("lists herdr's integrations as integration.list reports them, and refuses anything but GET", async () => {
    const res = await fetch(`${base()}/api/integrations`);
    expect(res.status).toBe(200);
    const { integrations } = (await res.json()) as IntegrationsResponse;
    const fromHerdr = (await herdrRpc<IntegrationsResponse>("integration.list", {})).integrations;
    expect(integrations).toEqual(fromHerdr);
    const claude = integrations.find((integration) => integration.target === "claude");
    expect(claude).toMatchObject({ label: "claude", command: "claude" });
    for (const integration of integrations) expect(["not_installed", "current", "outdated"]).toContain(integration.state);
    const post = await fetch(`${base()}/api/integrations`, { method: "POST" });
    expect(post.status).toBe(400);
    expect(((await post.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("offers omo and gjc, which herdr cannot start, exactly when they are on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ovis-shell-agents-"));
    const path = process.env["PATH"];
    const kinds = async () => ((await (await fetch(`${base()}/api/agents`)).json()) as { agents: AgentKind[] }).agents;
    try {
      process.env["PATH"] = bin;
      expect((await kinds()).map((agent) => agent.kind)).not.toContain("gjc");
      for (const name of ["omo", "gjc"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
      const offered = await kinds();
      expect(offered).toContainEqual({ kind: "omo", label: "OmO", installed: true });
      expect(offered).toContainEqual({ kind: "gjc", label: "Gajae Code", installed: true });
      // claude is always listed, and said to be missing where its command is not on PATH
      expect(offered).toContainEqual({ kind: "claude", label: "Claude Code", installed: false });
    } finally {
      process.env["PATH"] = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("offers a shell agent found only on its login shell's PATH, starts that same executable, keeps its hits until the next run, and finds a missed one put back on the PATH that run read", async () => {
    // a service PATH without gjc, and a test-owned login shell whose -l run puts it on PATH: no dotfile is read
    const root = mkdtempSync(join(tmpdir(), "ovis-login-path-"));
    const home = join(root, "home"), serviceBin = join(root, "service bin"), loginBin = join(root, "login bin");
    for (const dir of [home, serviceBin, loginBin]) mkdirSync(dir);
    const gjc = join(loginBin, "gjc");
    const alive = join(root, "alive"), release = join(root, "release");
    await Bun.$`mkfifo ${alive} ${release}`;
    // the fixture agent says who it is on `alive`, then stays in front of the pane under its own path,
    // reading `release` until the test closes it; it holds `alive` open, so that ends when it does
    const writeGjc = () => writeFileSync(gjc, `#!/bin/bash\nexec 3>'${alive}'\necho "$$" >&3\nexec -a "$0" cat '${release}'\n`, { mode: 0o755 });
    writeGjc();
    const shell = join(root, "login-shell");
    writeFileSync(shell, `#!/bin/sh\nif [ "$1" = "-l" ]; then PATH='${loginBin}:/usr/bin:/bin'; export PATH; shift; echo 'fixture motd'; fi\n[ "$1" = "-c" ] && exec /bin/sh -c "$2"\nexit 64\n`, { mode: 0o755 });
    const real = loginPathProbe({ shell, env: { HOME: home, PATH: serviceBin } });
    let runs = 0;
    const probe: LoginPathProbe = (signal) => { runs += 1; return real(signal); };
    // the answer's age is read from this clock: a minute passes only when the test says
    let clock = 0;
    const shellAgents = new ShellAgentLocator({ servicePath: () => serviceBin, probe, now: () => clock });
    const state = mkdtempSync(join(tmpdir(), "ovis-login-path-state-"));
    // installers' folders are looked up under the test's home, never the user's
    const agentDetector = new AgentDetector({ home, locate: catalogLocator({ probe: null, servicePath: () => serviceBin }) });
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, shellAgents, agentDetector });
    const url = `http://127.0.0.1:${app.port}`;
    const kinds = async () => ((await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentKind[] }).agents;
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-login-path" });
    const within = <T,>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })]).finally(() => clearTimeout(timer));
    };
    // subscribed before the launch: the fixture's pid line says it is up, the end of the stream that it is gone
    const watcher = Bun.spawn(["cat", alive], { stdout: "pipe" });
    const fixtureExited = watcher.exited;
    const firstLine = (async () => {
      const reader = watcher.stdout.getReader(), decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the fixture ended before it said it was up");
        text += decoder.decode(value, { stream: true });
      }
      return text.split("\n")[0]!;
    })();
    // closing the only writer of `release` ends the fixture's read, and its exit ends `alive`
    const releaseFixture = () => { try { closeSync(openSync(release, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); } catch { /* no reader: it never started or is gone */ } };
    let launchedPid: number | null = null;
    try {
      // no login shell runs until something asks
      expect(runs).toBe(0);
      // concurrent first reads share one run
      const reads = await Promise.all(Array.from({ length: 6 }, kinds));
      for (const agents of reads) {
        expect(agents).toContainEqual({ kind: "gjc", label: "Gajae Code", installed: true });
        expect(agents.map((agent) => agent.kind)).not.toContain("omo");
        // the wire shape is unchanged: kind, label and installed, nothing of where it was found
        for (const agent of agents) expect(Object.keys(agent).sort()).toEqual(["installed", "kind", "label"]);
      }
      expect(JSON.stringify(reads)).not.toContain(root);
      expect(runs).toBe(1);

      // the start types the absolute path the offer found, quoted: the fixture runs under it
      const res = await fetch(`${url}/api/tab/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" } }) });
      expect(res.status).toBe(200);
      const tab = await res.json() as WorkspaceCreated;
      expect(tab).toMatchObject({ agent_started: true });
      launchedPid = Number(await within(firstLine, 10_000, "the fixture never said it was up"));
      const info = await herdrRpc<{ process_info: { foreground_processes: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: tab.pane_id });
      expect(info.process_info.foreground_processes).toContainEqual(expect.objectContaining({ pid: launchedPid, argv: [gjc, release] }));
      // neither the reads nor the start ran a login shell of their own
      expect(runs).toBe(1);

      // a removed executable is offered no more, and nothing else takes its place before the next run
      rmSync(gjc);
      expect((await kinds()).map((agent) => agent.kind)).not.toContain("gjc");
      clock += 60_000;
      expect((await kinds()).map((agent) => agent.kind)).not.toContain("gjc");
      // back again on the PATH the last run read: found at once, with no new login shell, as a just-installed agent is
      writeGjc();
      expect(await kinds()).toContainEqual({ kind: "gjc", label: "Gajae Code", installed: true });
      expect(runs).toBe(2);

      // released, the fixture agent ends: nothing of it outlives the test
      releaseFixture();
      expect(await within(fixtureExited, 10_000, "the released fixture kept running")).toBe(0);
    } finally {
      releaseFixture();
      const released = await within(fixtureExited, 5000, "fixture still running").then(() => true, () => false);
      if (!released && launchedPid !== null) try { process.kill(launchedPid, "SIGKILL"); } catch { /* gone with its pane */ }
      watcher.kill();
      await fixtureExited;
      app.stop();
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  }, 60_000);

  it("makes one folder for the folder browser, and refuses names, folders and origins it must not", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-mkdir-"));
    const make = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base()}/api/workspace/directories`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const code = async (res: Response) => ((await res.json()) as ApiError).error.code;
    try {
      const made = await make({ path: root, name: "new-one" });
      expect(made.status).toBe(201);
      expect(await made.json()).toEqual({ path: join(root, "new-one") });
      expect(statSync(join(root, "new-one")).isDirectory()).toBeTrue();
      const again = await make({ path: root, name: "new-one" });
      expect(again.status).toBe(409);
      expect(await code(again)).toBe("folder_exists");
      for (const name of ["", "..", "a/b", "../escape"]) {
        const refused = await make({ path: root, name });
        expect(refused.status).toBe(400);
        expect(await code(refused)).toBe("invalid_name");
      }
      const missing = await make({ path: join(root, "missing"), name: "x" });
      expect(await code(missing)).toBe("invalid_cwd");
      expect(await code(await make({ path: root }))).toBe("invalid_body");
      // another site's page cannot make folders on this PC
      const crossSite = await make({ path: root, name: "from-elsewhere" }, { origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
      expect(existsSync(join(root, "from-elsewhere"))).toBeFalse();
      expect(existsSync(join(tmpdir(), "escape"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists an agent's commands for a folder before any pane runs it, locally and through the PC proxy, and refuses what it must", async () => {
    // GET /api/agent/commands?agent=&cwd=: paneCommands without a pane (the new workspace and tab
    // dialogs' skill list). A fixture folder with one Codex project skill; the folder is its own
    // repository boundary, so the scan climbs no further.
    const root = mkdtempSync(join(tmpdir(), "ovis-agent-commands-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, ".codex", "skills", "contract-skill"), { recursive: true });
      writeFileSync(join(root, ".codex", "skills", "contract-skill", "SKILL.md"), "---\nname: contract-skill\ndescription: A fixture skill.\n---\nBody.\n");
      const query = `?agent=codex&cwd=${encodeURIComponent(root)}`;
      const listed = await fetch(`${base()}/api/agent/commands${query}`);
      expect(listed.status).toBe(200);
      const { commands } = (await listed.json()) as { commands: { name: string; source: string; trigger?: string; origin?: string; provenance?: { verified: boolean } }[] };
      expect(commands).toContainEqual(expect.objectContaining({ name: "contract-skill", source: "skill", trigger: "$", origin: "project" }));
      expect(commands.some((command) => command.source === "builtin")).toBeTrue();
      // no process runs the agent: no row is verified against a version
      expect(commands.every((command) => command.provenance?.verified === false)).toBeTrue();
      // the same answer for this PC through the proxy path the remote PCs use
      const proxied = await fetch(`${base()}/api/machines/local/agent/commands${query}`);
      expect(proxied.status).toBe(200);
      expect(await proxied.json()).toEqual({ commands });
      const refusals: Array<[string, RequestInit | undefined, string]> = [
        ["", undefined, "missing_agent"],
        [`?agent=codex&cwd=${encodeURIComponent(join(root, "missing"))}`, undefined, "invalid_cwd"],
        ["?agent=codex", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "method_not_allowed"],
      ];
      for (const [refusedQuery, init, code] of refusals) {
        const refused = await fetch(`${base()}/api/agent/commands${refusedQuery}`, init);
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as ApiError).error.code).toBe(code);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace cwd that is not an existing directory", async () => {
    const res = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("invalid_cwd");
  });

  it("creates, edits, searches, inspects, and closes an owned workspace", async () => {
    writeFileSync(filePath, "mention fixture");
    // the dialog sends null for "not given" (agent: null = shell only): nulls must read as absent
    const create = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), label, agent: null }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as WorkspaceCreated;
    workspaceId = created.workspace_id;
    paneId = created.pane_id;
    expect(created.agent_started).toBeFalse();

    const commands = await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({ commands: [] });

    const files = await fetch(`${base()}/api/pane/files?pane_id=${encodeURIComponent(paneId)}&q=${encodeURIComponent(fileName)}&limit=5`);
    expect(files.status).toBe(200);
    expect(((await files.json()) as { files: string[] }).files).toContain(fileName);

    const prompt = await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toEqual({ prompt: null, suggestion: null, restored: null });

    for (const [path, body] of [
      ["/api/workspace/rename", { workspace_id: workspaceId, label: `${label}-renamed` }],
      ["/api/workspace/move", { workspace_id: workspaceId, insert_index: 0 }],
      ["/api/pane/rename", { pane_id: paneId, label: "renamed pane" }],
    ] as const) {
      const changed = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(changed.status).toBe(200);
      // a move's receipt names it in this server's order (server/order-sequence.ts); the rest answer as before
      if (path === "/api/workspace/move") expect(await changed.json()).toEqual({ ok: true, order_epoch: expect.any(String), moved_seq: expect.any(Number) });
      else expect(await changed.json()).toEqual({ ok: true });
    }

    const close = await fetch(`${base()}/api/workspace/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ ok: true });
    workspaceId = null;
  }, 20_000);

  it("pushes session-changed when POST /api/workspace/close answers, not after the collector's debounce", async () => {
    // connected before the creation: its frame comes from the collector, debounced, and on a busy PC
    // it could go out before a socket connected afterwards subscribed, which then waited in vain
    const socket = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    let closing: Awaited<ReturnType<typeof workspaceCreate>> | null = null;
    try {
      closing = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-close-push" });
      // the creation's own frame, debounced, is not the close's
      await socket.waitFor((frame) => frame.type === "session-changed", "session-changed after create", 5_000);
      const before = new Set(socket.seen);
      const changed = socket.waitFor((frame) => frame.type === "session-changed" && !before.has(frame), "session-changed after close", 5_000).then(() => performance.now());
      const response = await fetch(`${base()}/api/workspace/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: closing.workspace.workspace_id }),
      });
      const answered = performance.now();
      expect(response.status).toBe(200);
      expect(await changed - answered).toBeLessThan(250);
    } finally {
      socket.close();
      if (closing) await herdrRpc("workspace.close", { workspace_id: closing.workspace.workspace_id }).catch(() => undefined);
    }
  }, 20_000);

  it("pushes session-changed when a tab, workspace or worktree create answers, not after the collector's debounce", async () => {
    // the page draws a new pane only once the roster lists it, and the roster is read on this frame
    const repo = mkdtempSync(join(tmpdir(), "ovis-create-push-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "create push fixture\n");
    expect(git("add", "README.md").exitCode).toBe(0);
    expect(git("commit", "-q", "-m", "fixture").exitCode).toBe(0);
    const socket = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const owned: string[] = [];
    // until no session-changed comes for 700 ms: the collector's debounced one (500 ms after herdr's event) is not the next create's
    const quiet = async (): Promise<void> => {
      const changes = () => socket.seen.filter((frame) => frame.type === "session-changed").length;
      const deadline = Date.now() + 10_000;
      let count = changes(), since = Date.now();
      while (Date.now() - since < 700) {
        if (Date.now() > deadline) throw new Error("session-changed frames did not stop within 10s");
        await Bun.sleep(25);
        if (changes() !== count) { count = changes(); since = Date.now(); }
      }
    };
    // ms from the answer to the first session-changed after the request: the collector's comes 500 ms late
    const pushedOnAnswer = async (path: string, body: unknown): Promise<number> => {
      const before = new Set(socket.seen);
      const changed = socket.waitFor((frame) => frame.type === "session-changed" && !before.has(frame), `session-changed after ${path}`, 5_000).then(() => performance.now());
      const response = await fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answered = performance.now();
      expect(response.status).toBe(200);
      owned.push(((await response.json()) as WorkspaceCreated).workspace_id);
      const pushed = await changed - answered;
      await quiet();
      return pushed;
    };
    try {
      const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-create-push" });
      owned.push(parent.workspace.workspace_id);
      await socket.waitFor((frame) => frame.type === "session-changed", "session-changed after setup", 5_000);
      await quiet();
      expect(await pushedOnAnswer("/api/tab/create", { workspace_id: parent.workspace.workspace_id })).toBeLessThan(250);
      expect(await pushedOnAnswer("/api/workspace/create", { cwd: repo, label: "ovis-test-create-push-2" })).toBeLessThan(250);
      const checkout = join(`${repo}-checkouts`, "feature");
      expect(await pushedOnAnswer("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "ovis-test-create-push", path: checkout })).toBeLessThan(250);
      // opening a worktree that is open already answers from the same route: it pushes too
      expect(await pushedOnAnswer("/api/worktree/open", { workspace_id: parent.workspace.workspace_id, path: checkout })).toBeLessThan(250);
    } finally {
      socket.close();
      for (const id of new Set(owned)) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
      rmSync(`${repo}-checkouts`, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("says a repository has no commits yet instead of passing git's refusal on", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ovis-worktree-empty-"));
    expect(Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-worktree-empty" });
    const checkout = join(`${repo}-checkouts`, "feature");
    try {
      const create = await fetch(`${base()}/api/worktree/create`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: parent.workspace.workspace_id, branch: "ovis-test-unborn", path: checkout }),
      });
      expect(create.status).toBe(409);
      expect(((await create.json()) as ApiError).error.code).toBe("repository_without_commits");
      expect(existsSync(checkout)).toBeFalse();
    } finally {
      await herdrRpc("workspace.close", { workspace_id: parent.workspace.workspace_id }).catch(() => undefined);
      rmSync(repo, { recursive: true, force: true });
      rmSync(`${repo}-checkouts`, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates a worktree of an owned repository as a grouped workspace, lists it, and opens it again", async () => {
    // a repository with one commit: a worktree needs a branch to start from
    const repo = mkdtempSync(join(tmpdir(), "ovis-worktree-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "worktree fixture\n");
    expect(git("add", "README.md").exitCode).toBe(0);
    expect(git("commit", "-q", "-m", "fixture").exitCode).toBe(0);
    const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-worktree-parent" });
    const owned = [parent.workspace.workspace_id];
    // the checkout lives under the test's own folders, never under the user's worktree directory
    const checkouts = `${repo}-checkouts`;
    const checkout = join(checkouts, "feature");
    const post = (path: string, body: unknown) => fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const missing = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as ApiError).error.code).toBe("missing_branch");
      const badAgent = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "ovis-test-feature", path: checkout, agent: { kind: "muse", args: "--help" } });
      expect(badAgent.status).toBe(400);
      expect(((await badAgent.json()) as ApiError).error.code).toBe("invalid_agent");
      expect(existsSync(checkout)).toBeFalse();

      const create = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "ovis-test-feature", base: null, label: null, path: checkout });
      expect(create.status).toBe(200);
      const opened = (await create.json()) as WorktreeOpened;
      owned.push(opened.workspace_id);
      expect(opened.already_open).toBeFalse();
      // no agent was asked for: the answer says nothing about one
      expect(opened.agent_started).toBeUndefined();
      expect(opened.branch).toBe("ovis-test-feature");
      expect(realpathSync(opened.path)).toBe(realpathSync(checkout));
      const child = (await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === opened.workspace_id);
      expect(child?.worktree?.is_linked_worktree).toBeTrue();

      const list = await fetch(`${base()}/api/worktree/list?workspace_id=${encodeURIComponent(parent.workspace.workspace_id)}`);
      expect(list.status).toBe(200);
      const listing = (await list.json()) as WorktreeListing;
      expect(listing.worktrees.some((entry) => entry.branch === "ovis-test-feature" && entry.open_workspace_id === opened.workspace_id)).toBeTrue();

      const again = await post("/api/worktree/open", { workspace_id: parent.workspace.workspace_id, path: checkout });
      expect(again.status).toBe(200);
      const reopened = (await again.json()) as WorktreeOpened;
      expect(reopened.already_open).toBeTrue();
      expect(reopened.workspace_id).toBe(opened.workspace_id);

      // a dirty checkout is refused without force, in git's words; the repository's workspace
      // does not close over its open worktrees unless the group is meant
      writeFileSync(join(checkout, "unsaved.txt"), "dirty\n");
      const refused = await post("/api/worktree/remove", { workspace_id: opened.workspace_id });
      expect(refused.status).toBe(404);
      expect(((await refused.json()) as ApiError).error.code).toBe("dirty_worktree_requires_force");
      const grouped = await post("/api/workspace/close", { workspace_id: parent.workspace.workspace_id });
      expect(grouped.status).toBe(404);
      expect(((await grouped.json()) as ApiError).error.code).toBe("workspace_group_close_required");
      const removed = await post("/api/worktree/remove", { workspace_id: opened.workspace_id, force: true });
      expect(removed.status).toBe(200);
      expect((await removed.json()) as WorktreeRemoved).toMatchObject({ ok: true, forced: true });
      expect(existsSync(checkout)).toBeFalse();
      expect((await sessionSnapshot()).workspaces.some((workspace) => workspace.workspace_id === opened.workspace_id)).toBeFalse();

      // a clean worktree closes with its repository's workspace when the group is meant; its checkout stays.
      // An agent asked for with the checkout starts in its pane, as one asked for with a workspace does.
      const second = (await (await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "ovis-test-second", path: join(checkouts, "second"), agent: { kind: "muse" } })).json()) as WorktreeOpened;
      owned.push(second.workspace_id);
      expect(second.error).toBeUndefined();
      expect(second.agent_started).toBeTrue();
      expect((await herdrRpc<{ agent: { name: string } }>("agent.get", { target: second.pane_id })).agent.name).toStartWith("muse");
      const closedGroup = await post("/api/workspace/close", { workspace_id: parent.workspace.workspace_id, close_group: true });
      expect(closedGroup.status).toBe(200);
      const left = (await sessionSnapshot()).workspaces.map((workspace) => workspace.workspace_id);
      expect(left).not.toContain(parent.workspace.workspace_id);
      expect(left).not.toContain(second.workspace_id);
      expect(existsSync(join(checkouts, "second"))).toBeTrue();
    } finally {
      // the roster says what was made: a create whose answer was lost still left a child to remove
      const repoRoot = realpathSync(repo);
      const children = new Set(owned.slice(1));
      const snapshot = await sessionSnapshot().catch(() => null);
      for (const workspace of snapshot?.workspaces ?? []) {
        if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot) children.add(workspace.workspace_id);
      }
      for (const id of children) await herdrRpc("worktree.remove", { workspace_id: id, force: true }).catch(() => undefined);
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
      rmSync(checkouts, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts a worktree asked from a workspace on a linked checkout at the repository's own workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ovis-worktree-linked-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "worktree fixture\n");
    expect(git("add", "README.md").exitCode).toBe(0);
    expect(git("commit", "-q", "-m", "fixture").exitCode).toBe(0);
    const checkouts = `${repo}-checkouts`;
    // a checkout git made, opened as a plain workspace: herdr does not mark it as a worktree
    expect(git("worktree", "add", "-q", "-b", "ovis-test-linked", join(checkouts, "linked")).exitCode).toBe(0);
    const linked = await workspaceCreate({ cwd: join(checkouts, "linked"), label: "ovis-test-worktree-linked" });
    const owned = [linked.workspace.workspace_id];
    const post = (path: string, body: unknown) => fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === linked.workspace.workspace_id)?.worktree?.is_linked_worktree).not.toBeTrue();
      // the repository's own workspace is not open: herdr's refusal is the answer
      const alone = await post("/api/worktree/create", { workspace_id: linked.workspace.workspace_id, branch: "ovis-test-alone", path: join(checkouts, "alone") });
      expect(alone.status).toBe(404);
      expect(((await alone.json()) as ApiError).error.code).toBe("linked_worktree_source");
      expect(existsSync(join(checkouts, "alone"))).toBeFalse();

      const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-worktree-linked-parent" });
      owned.push(parent.workspace.workspace_id);
      const create = await post("/api/worktree/create", { workspace_id: linked.workspace.workspace_id, branch: "ovis-test-from-linked", path: join(checkouts, "from-linked") });
      expect(create.status).toBe(200);
      const opened = (await create.json()) as WorktreeOpened;
      owned.push(opened.workspace_id);
      expect(opened.branch).toBe("ovis-test-from-linked");
      expect(existsSync(join(checkouts, "from-linked"))).toBeTrue();
      expect((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === opened.workspace_id)?.worktree?.is_linked_worktree).toBeTrue();

      const again = await post("/api/worktree/open", { workspace_id: linked.workspace.workspace_id, path: join(checkouts, "from-linked") });
      expect(again.status).toBe(200);
      expect((await again.json()) as WorktreeOpened).toMatchObject({ workspace_id: opened.workspace_id, already_open: true });
    } finally {
      const repoRoot = realpathSync(repo);
      const snapshot = await sessionSnapshot().catch(() => null);
      for (const workspace of snapshot?.workspaces ?? []) {
        if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot) await herdrRpc("worktree.remove", { workspace_id: workspace.workspace_id, force: true }).catch(() => undefined);
      }
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
      rmSync(checkouts, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts another agent of a kind whose name is already taken", async () => {
    // muse stands in for the agent: herdr answers agent.start once the launch is typed into the
    // pane, so the kind needs no program behind it and no real agent runs
    const kind = "muse";
    const explicit = `given-${Math.random().toString(36).slice(2, 10)}`;
    const owned: string[] = [];
    const start = async (agent: { kind: string; name?: string }) => {
      const res = await fetch(`${base()}/api/workspace/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: tmpdir(), label: `${label}-agent-${owned.length}`, agent }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as WorkspaceCreated;
      owned.push(created.workspace_id);
      expect(created.error).toBeUndefined();
      expect(created.agent_started).toBeTrue();
      return (await herdrRpc<{ agent: { name?: string | null } }>("agent.get", { target: created.pane_id })).agent.name;
    };
    try {
      const first = await start({ kind });
      const second = await start({ kind });
      expect(first).toMatch(/^muse(-\d+)?$/);
      expect(second).toMatch(/^muse-\d+$/);
      expect(second).not.toBe(first);
      // a name the client gives is used as given
      expect(await start({ kind, name: explicit })).toBe(explicit);
    } finally {
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
    }
  }, 20_000);

  it("uses the shared error envelope for malformed mutation bodies", async () => {
    for (const [path, body, code] of [
      ["/api/workspace/rename", {}, "missing_workspace_id"],
      // #927: herdr would keep a blank or any-length name
      ["/api/workspace/rename", { workspace_id: "x", label: "" }, "missing_label"],
      ["/api/workspace/rename", { workspace_id: "x", label: "   " }, "missing_label"],
      ["/api/workspace/rename", { workspace_id: "x", label: "W".repeat(81) }, "label_too_long"],
      ["/api/worktree/create", { workspace_id: "x", branch: "b", label: "W".repeat(81) }, "label_too_long"],
      ["/api/worktree/open", { workspace_id: "x", path: "/tmp", label: "W".repeat(81) }, "label_too_long"],
      ["/api/workspace/move", { workspace_id: "x", insert_index: -1 }, "invalid_index"],
      ["/api/workspace/close", {}, "missing_workspace_id"],
      ["/api/pane/rename", {}, "missing_pane_id"],
      ["/api/pane/focus", {}, "missing_pane_id"],
      ["/api/pane/swap", { pane_id: "x", direction: "right", target_pane_id: "y" }, "invalid_pane_swap"],
      ["/api/pane/swap", { pane_id: "x", target_pane_id: "" }, "invalid_target_pane_id"],
      ["/api/pane/move", { target_pane_id: "y", side: "left" }, "missing_pane_id"],
      ["/api/pane/move", { pane_id: "x", side: "left" }, "invalid_target_pane_id"],
      ["/api/pane/move", { pane_id: "x", target_pane_id: "y" }, "invalid_side"],
      ["/api/pane/move", { pane_id: "x", target_pane_id: "y", side: "middle" }, "invalid_side"],
      ["/api/layout/ratio", {}, "missing_tab_id"],
      ["/api/layout/ratio", { tab_id: "x", path: [0], ratio: 0.5 }, "invalid_path"],
      ["/api/layout/ratio", { tab_id: "x", path: [], ratio: 1 }, "invalid_ratio"],
      ["/api/agent/rename", {}, "missing_pane_id"],
    ] as const) {
      const res = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("GET /api/pane/omo-tasks", () => {
  it("answers a busy Claude task-list scan with retryable 503 while bridge health stays available", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-claude-task-busy-"));
    const path = join(root, "synthetic.jsonl");
    writeFileSync(path, "");
    const original = ClaudeSubagentStatus.prototype.sessionOf;
    const session = spyOn(ClaudeSubagentStatus.prototype, "sessionOf").mockImplementation(function(this: ClaudeSubagentStatus, paneId) {
      return paneId === "busy-claude-pane" ? { path, live: true, startedAt: null, read: 1 } : original.call(this, paneId);
    });
    setFilePoolOptions({ workers: 0, waiting: 0 });
    try {
      const response = await fetch(`${base()}/api/pane/omo-tasks?pane_id=busy-claude-pane`);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toMatchObject({ error: { code: "file_busy" } });
      expect((await fetch(`${base()}/api/health?scope=bridge`)).status).toBe(200);
    } finally {
      session.mockRestore();
      setFilePoolOptions();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges running bash, monitor and eval jobs ahead of ended tasks and jobs", async () => {
    // Given task records and the core tracker's transcript jobs for the same session.
    const cwd = mkdtempSync(join(tmpdir(), "ovis-omo-merged-tasks-"));
    const now = new Date().toISOString();
    const tasks = join(cwd, ".omo", "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    for (const [id, status] of [["st_running", "running"], ["st_ended", "completed"]]) {
      writeFileSync(join(tasks, `${id}.json`), JSON.stringify({
        task_id: id, parent_session_id: "merged-session", host_pid: process.pid, status,
        task_summary: id, started_at: now, terminal_at: now,
      }));
    }
    const jobs = omoJobTasks({
      running: [
        { id: "bash_1", kind: "command", title: "bun test", at: Date.parse(now) },
        { id: "mon_FIRST", kind: "monitor", title: "test completion", at: Date.parse(now) },
        { id: "cell-1", kind: "cell", title: "run tests", at: Date.parse(now) },
      ],
      ended: [{ id: "bash_2", kind: "command", title: "bun build", at: Date.parse(now), ended: { at: Date.parse(now), status: "completed" } }],
    }, null);
    const session = spyOn(OmoStatus.prototype, "sessionOf").mockImplementation((paneId) => paneId === "merged-pane" ? { cwd, sessionId: "merged-session" } : null);
    const background = spyOn(OmoStatus.prototype, "jobsOf").mockImplementation((paneId) => paneId === "merged-pane" ? jobs : []);
    try {
      // When the browser requests the merged list through HTTP.
      const response = await fetch(`${base()}/api/pane/omo-tasks?pane_id=merged-pane`);
      const body = await response.json() as { tasks: { id: string; category: string | null; status: string }[] };
      // Then running jobs precede even the ended task record, and neither source is lost.
      expect(response.status).toBe(200);
      expect(body.tasks.map((task) => [task.id, task.status])).toEqual([
        ["st_running", "running"], ["bash_1", "running"], ["mon_FIRST", "running"], ["cell-1", "running"],
        ["st_ended", "completed"], ["bash_2", "completed"],
      ]);
      expect(body.tasks.slice(1, 4).map((task) => task.category)).toEqual(["bash", "monitor", "eval"]);
      expect(background).toHaveBeenCalledWith("merged-pane");
    } finally {
      session.mockRestore();
      background.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("answers 400 without a pane, and no tasks for a pane that runs no OmO", async () => {
    const missing = await fetch(`${base()}/api/pane/omo-tasks`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ApiError).error.code).toBe("missing_pane_id");
    const unknown = await fetch(`${base()}/api/pane/omo-tasks?pane_id=w0:p0`);
    expect(unknown.status).toBe(200);
    const body = await unknown.json() as { tasks: unknown[]; runs: unknown[]; server_time: string };
    expect(body.tasks).toEqual([]);
    expect(body.runs).toEqual([]);
    expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  });
});

describe("GET /api/session", () => {
  it("returns the live herdr snapshot with at least one real workspace", async () => {
    const res = await fetch(`${base()}/api/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: SessionSnapshot };
    expect(Array.isArray(body.snapshot.workspaces)).toBe(true);
    expect(body.snapshot.workspaces.length).toBeGreaterThan(0);
    // Every workspace carries the identity fields the sidebar renders.
    for (const ws of body.snapshot.workspaces) {
      expect(typeof ws.workspace_id).toBe("string");
      expect(ws.workspace_id.length).toBeGreaterThan(0);
      expect(typeof ws.label).toBe("string");
    }
    expect(body.snapshot.panes.length).toBeGreaterThan(0);
    expect(typeof body.snapshot.finish_epoch).toBe("string");
    expect(body.snapshot.finish_epoch?.length).toBeGreaterThan(0);
    expect(body.snapshot.panes.every((pane) => Number.isSafeInteger(pane.finish_id))).toBe(true);
  });

  it("names the herdr it read: the same from another server on it, another for another herdr, none it cannot prove", async () => {
    const lifetime = async (origin: string): Promise<string | undefined> =>
      ((await (await fetch(`${origin}/api/session`)).json()) as { snapshot: SessionSnapshot }).snapshot.herdr_lifetime;
    const own = await lifetime(base());
    expect(own).toMatch(/^[0-9a-f]{32}$/);
    let identity: string | null = "a fake herdr";
    const dirs = [mkdtempSync(join(tmpdir(), "ovis-lifetime-")), mkdtempSync(join(tmpdir(), "ovis-lifetime-"))];
    const restarted = createServer({ port: 0, stateDir: dirs[0], machines: false });
    const other = createServer({ port: 0, stateDir: dirs[1], machines: false, herdrIdentity: () => identity });
    try {
      expect(await lifetime(`http://127.0.0.1:${restarted.port}`)).toBe(own);
      const fake = await lifetime(`http://127.0.0.1:${other.port}`);
      expect(fake).toMatch(/^[0-9a-f]{32}$/);
      expect(fake).not.toBe(own);
      identity = null;
      expect(await lifetime(`http://127.0.0.1:${other.port}`)).toBeUndefined();
    } finally {
      await Promise.all([restarted.stop(), other.stop()]);
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/pane/find viewport results", () => {
  let workspaceId: string;
  let paneId: string;
  beforeAll(async () => {
    const created = await workspaceCreate({ cwd: stateDir, label: "ovis-test-find-response" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    const ready = herdrRpc("pane.wait_for_output", {
      pane_id: paneId, source: "visible", match: { type: "substring", value: "find_response_ready" }, timeout_ms: 10000,
    }, undefined, 12000);
    await herdrRpc("pane.send_input", { pane_id: paneId, text: "printf 'find_response_%s\\n' ready; exec cat", keys: ["enter"] });
    await ready;
  }, 15000);
  afterAll(async () => { if (workspaceId) await workspaceClose(workspaceId); });

  it("includes bounded cell ranges and the unchanged shared viewport for jump:false", async () => {
    const before = await (await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`)).json() as { scroll: PaneFindResponse["scroll"] };
    const response = await fetch(`${base()}/api/pane/find`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId, query: "find_response_ready", direction: "backward", jump: false }),
    });
    expect(response.status).toBe(200);
    const body: PaneFindResponse = await response.json();
    expect(body.total).toBe(1);
    expect(body.matches).toEqual([body.match!]);
    expect(body.scroll).toEqual(before.scroll);
    expect(Number.isSafeInteger(body.content_revision)).toBe(true);
    const after = await (await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`)).json() as { scroll: PaneFindResponse["scroll"] };
    expect(after.scroll).toEqual(before.scroll);
  });

  it("rejects a non-boolean jump with the shared error envelope", async () => {
    const response = await fetch(`${base()}/api/pane/find`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId, query: "ready", direction: "forward", jump: "false" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_jump", message: "jump must be a boolean" } });
  });
});

describe("/api/pane/scroll and /api/pane/selection", () => {
  async function firstPane(): Promise<string> {
    const { snapshot } = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
    expect(snapshot.panes[0]).toBeDefined();
    return snapshot.panes[0]!.pane_id;
  }

  it("reads and sets the viewport position of a real pane", async () => {
    const paneId = await firstPane();
    const read = await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`);
    expect(read.status).toBe(200);
    const { scroll } = (await read.json()) as { scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } };
    expect(Number.isInteger(scroll.max_offset_from_bottom)).toBe(true);
    expect(scroll.viewport_rows).toBeGreaterThan(0);
    const set = await fetch(`${base()}/api/pane/scroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, offset_from_bottom: 0 }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { scroll: { offset_from_bottom: number } }).scroll.offset_from_bottom).toBe(0);
  });

  it("reads a selection from the pane's history", async () => {
    const paneId = await firstPane();
    const query = new URLSearchParams({ pane_id: paneId, anchor_row: "0", anchor_col: "0", cursor_row: "0", cursor_col: "0" });
    const response = await fetch(`${base()}/api/pane/selection?${query}`);
    // an empty first cell has no text: herdr's refusal still comes back as a JSON error
    const body = (await response.json()) as { text?: string; error?: { code: string } };
    if (response.ok) expect(typeof body.text).toBe("string");
    else expect(typeof body.error?.code).toBe("string");
  });

  it("rejects bad coordinates and offsets before any RPC", async () => {
    for (const query of ["", "pane_id=w1:p1&anchor_row=0&anchor_col=0&cursor_row=0", "pane_id=w1:p1&anchor_row=-1&anchor_col=0&cursor_row=0&cursor_col=0", "pane_id=w1:p1&anchor_row=1.5&anchor_col=0&cursor_row=0&cursor_col=0"]) {
      const response = await fetch(`${base()}/api/pane/selection?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(query ? "invalid_range" : "missing_pane_id");
    }
    for (const offset of [-1, 1.5, "3", null]) {
      const response = await fetch(`${base()}/api/pane/scroll`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: "w1:p1", offset_from_bottom: offset }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe("invalid_offset");
    }
    expect((await fetch(`${base()}/api/pane/scroll`)).status).toBe(400);
  });
});

describe("GET /api/pane/read", () => {
  it("returns terminal text for a real live pane", async () => {
    const snapRes = await fetch(`${base()}/api/session`);
    const { snapshot } = (await snapRes.json()) as { snapshot: SessionSnapshot };
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();

    const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane!.pane_id)}&source=visible&format=text`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: PaneReadResult };
    expect(body.read.pane_id).toBe(pane!.pane_id);
    expect(typeof body.read.text).toBe("string");
  });

  it("rejects an unknown pane id with a clean JSON error and keeps serving", async () => {
    const res = await fetch(`${base()}/api/pane/read?pane_id=w9999:p9999&source=visible&format=text`);
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(typeof body.error.code).toBe("string");
    // the server survives a bad request
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });

  it("rejects a missing pane_id parameter", async () => {
    const res = await fetch(`${base()}/api/pane/read?source=visible`);
    expect(res.status).toBe(400);
  });

  it("reads omitted, zero and small line counts on a live pane with source and format unchanged", async () => {
    const { snapshot } = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
    const pane = snapshot.panes[0]!;
    for (const suffix of ["", "&lines=0", "&lines=1", "&lines=5", "&lines=0400"]) {
      const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane.pane_id)}&source=recent&format=ansi${suffix}`);
      expect(res.status).toBe(200);
      const { read } = (await res.json()) as { read: PaneReadResult };
      expect(read.pane_id).toBe(pane.pane_id);
      expect(read.source).toBe("recent");
      expect(read.format).toBe("ansi");
    }
  });

  it("refuses invalid line counts with invalid_lines for known and unknown panes and keeps serving", async () => {
    const { snapshot } = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
    for (const pane of [snapshot.panes[0]!.pane_id, "w9999:p9999"]) {
      for (const lines of ["", "%20%20", "-1", "0.5", "NaN", "Infinity", "4294967296", "9007199254740993", "0.99999999999999999", "1.0", "1e3", "%2B5"]) {
        const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane)}&lines=${lines}`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiError).error.code).toBe("invalid_lines");
      }
    }
    const unknown = await fetch(`${base()}/api/pane/read?pane_id=w9999:p9999&lines=10`);
    expect(((await unknown.json()) as ApiError).error.code).toBe("pane_not_found");
    for (const [query, code] of [["source=everything", "invalid_source"], ["format=html", "invalid_format"]] as const) {
      const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(snapshot.panes[0]!.pane_id)}&lines=10&${query}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/health`)).status).toBe(200);
  });
});

describe("POST /api/pane/close", () => {
  /** Own workspace again: this test really kills its root pane, never a user pane. */
  let workspaceId: string | null = null;
  let paneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-close", cwd: "/tmp", focus: false },
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
  });

  it("closes the named pane and it leaves the snapshot", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // real cross-process state: fake timers cannot see herdr's snapshot, so this is
    // one of the rare genuine-delay polls (same shape as the exit test's retries)
    let gone = false;
    for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      gone = !session.snapshot.panes.some((pane) => pane.pane_id === paneId);
      if (!gone) await Bun.sleep(500);
    }
    expect(gone).toBeTrue();
  }, 20000);

  it("answers the error envelope for an unknown pane", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "no-such-pane" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBeTruthy();
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects a missing pane_id with 400 missing_pane_id", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("missing_pane_id");
  });
});

describe("POST /api/pane/image", () => {
  /** Own workspace with its own cwd: the upload writes a real file into it. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let qaCwd: string | null = null;

  // a real 1x1 png
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const post = (body: unknown) =>
    fetch(`${base()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    qaCwd = mkdtempSync(join(tmpdir(), "ovis-image-"));
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-image", cwd: qaCwd, focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
    if (qaCwd) rmSync(qaCwd, { recursive: true, force: true });
    for (const project of gitProjects.splice(0)) {
      await herdrRpc("workspace.close", { workspace_id: project.workspaceId });
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });

  /** A pane of its own whose cwd is a fresh Git project, so `git status` sees what an upload leaves. */
  const gitProjects: { cwd: string; workspaceId: string }[] = [];
  const gitProjectPane = async (label: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "ovis-image-git-"));
    expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label, cwd, focus: false },
    );
    gitProjects.push({ cwd, workspaceId: created.workspace.workspace_id });
    return { cwd, paneId: created.root_pane.pane_id };
  };
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const gitStatus = (cwd: string) => git(cwd, "status", "--porcelain", "--untracked-files=all").stdout.toString().split("\n").filter(Boolean);
  const pathOf = async (res: Response) => ((await res.json()) as { path: string }).path;

  it("stores a pasted image under the pane cwd and returns its absolute path", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    // the prompt must reference a file the agent can read without leaving its project
    expect(body.path.startsWith(qaCwd!)).toBe(true);
    expect(body.path.includes(".ovis")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const stored = statSync(body.path);
    expect(stored.size).toBeGreaterThan(0);
    expect(stored.isFile()).toBe(true);
  });

  it("rejects an unknown pane with the shared error envelope", async () => {
    const res = await post({ pane_id: "w9999:p9999", content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pane_not_found");
  });

  const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)));
  const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const pasted = () => existsSync(join(qaCwd!, ".ovis")) ? readdirSync(join(qaCwd!, ".ovis")).sort() : [];

  it("names each raster after its signature, whichever supported type it claims", async () => {
    for (const [extension, data] of [
      ["png", Buffer.from(TINY_PNG_BASE64, "base64")],
      ["jpg", bytes([255, 216, 255, 224, 0, 16], "JFIF")],
      ["gif", bytes("GIF87a", [1, 0, 1, 0])],
      ["gif", bytes("GIF89a", [1, 0, 1, 0])],
      ["webp", bytes("RIFF", [4, 0, 0, 0], "WEBP")],
    ] as const) {
      for (const content_type of RASTER_TYPES) {
        const res = await post({ pane_id: qaPaneId, content_type, data_base64: data.toString("base64"), name: "shot.jpeg" });
        expect(res.status).toBe(200);
        const { path } = (await res.json()) as { path: string };
        expect(dirname(path)).toBe(join(qaCwd!, ".ovis"));
        expect(basename(path)).toMatch(new RegExp(`^paste-\\d{8}-\\d{6}-[0-9a-f]{8}\\.${extension}$`));
        expect(readFileSync(path)).toEqual(data);
      }
    }
  });

  it("refuses a fake raster with invalid_image before the pane lookup, writing nothing", async () => {
    const before = pasted();
    for (const data of [
      bytes("SECRET-UPLOAD-TEXT not an image"),
      bytes([137, 80, 78, 71, 13, 10, 26]),
      bytes([255, 216]),
      bytes("GIF88a"),
      bytes("RIFF", [4, 0, 0, 0], "WEB"),
      // GIF87a, GIF89a and RIFF....WEBP with each letter's high bit set
      bytes([0xc7, 0xc9, 0xc6, 0x38, 0x37, 0xe1]),
      bytes([0xc7, 0xc9, 0xc6, 0x38, 0x39, 0xe1]),
      bytes([0xd2, 0xc9, 0xc6, 0xc6, 4, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]),
    ]) {
      for (const content_type of RASTER_TYPES) {
        for (const pane_id of [qaPaneId, "w9999:p9999"]) {
          const res = await post({ pane_id, content_type, data_base64: data.toString("base64"), name: "secret-name.png" });
          expect(res.status).toBe(400);
          const text = await res.text();
          expect(JSON.parse(text)).toEqual({ error: { code: "invalid_image", message: "file does not contain a supported raster image" } });
          for (const leaked of ["SECRET", "secret-name", "path"]) expect(text).not.toContain(leaked);
        }
      }
    }
    expect(pasted()).toEqual(before);
    // a real raster for an unknown pane still answers pane_not_found, and size errors still come first
    const gif = await post({ pane_id: "w9999:p9999", content_type: "image/webp", data_base64: bytes("GIF89a", [1, 0]).toString("base64") });
    expect([gif.status, ((await gif.json()) as ApiError).error.code]).toEqual([404, "pane_not_found"]);
    const empty = await post({ pane_id: "w9999:p9999", content_type: "image/png", data_base64: "" });
    expect([empty.status, ((await empty.json()) as ApiError).error.code]).toEqual([400, "empty_image"]);
  });

  it("keeps generic uploads under their own names and bytes, even when they look like a raster", async () => {
    for (const [content_type, name, data, pattern] of [
      ["application/json", "report.json", bytes('{"month":"2026-09"}'), /^report-.*\.json$/],
      ["application/zip", "bundle.zip", Buffer.from(TINY_PNG_BASE64, "base64"), /^bundle-.*\.zip$/],
    ] as const) {
      const res = await post({ pane_id: qaPaneId, content_type, data_base64: data.toString("base64"), name });
      expect(res.status).toBe(200);
      const { path } = (await res.json()) as { path: string };
      expect(basename(path)).toMatch(pattern);
      expect(readFileSync(path)).toEqual(data);
    }
  });

  it("stores any other file under its own sanitised name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/svg+xml", data_base64: svg, name: "../omo icon.SVG" });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith(join(qaCwd!, ".ovis") + "/")).toBe(true);
    expect(basename(path)).toMatch(/^omo_icon-\d{8}-\d{6}-[0-9a-f]{8}\.svg$/);
    expect(readFileSync(path, "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    // no name, or one without a usable extension: still stored, as .bin
    const bare = (await (await post({ pane_id: qaPaneId, content_type: "", data_base64: svg })).json()) as { path: string };
    expect(basename(bare.path)).toMatch(/^file-.*\.bin$/);
  });

  it("keeps a pasted image and a named file out of Git status, each readable by its returned path", async () => {
    const { cwd, paneId } = await gitProjectPane("ovis-test-image-git");
    const png = Buffer.from(TINY_PNG_BASE64, "base64");
    const json = Buffer.from('{"tool":"herdr","ok":true}\n');
    // both at once: whichever creates the folder's ignore file first, the other finds it there
    const answers = await Promise.all([
      post({ pane_id: paneId, content_type: "image/png", data_base64: png.toString("base64") }),
      post({ pane_id: paneId, content_type: "application/json", data_base64: json.toString("base64"), name: "report.json" }),
    ]);
    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    const paths = await Promise.all(answers.map(pathOf));
    expect(readFileSync(join(cwd, ".ovis", ".gitignore"), "utf8")).toBe("*\n");
    expect(gitStatus(cwd)).toEqual([]);
    for (const [index, path] of paths.entries()) {
      const ignored = git(cwd, "check-ignore", path);
      expect(ignored.exitCode).toBe(0);
      expect(ignored.stdout.toString().trim()).toBe(path);
      // ignored is not unreachable: the explicit path still opens, on disk and through the viewer's route
      const bytes = index === 0 ? png : json;
      expect(readFileSync(path).equals(bytes)).toBe(true);
      const opened = await fetch(`${base()}/api/fs/file?pane_id=${encodeURIComponent(paneId)}&path=${encodeURIComponent(path)}`);
      expect(opened.status).toBe(200);
      expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true);
    }
  });

  it("preserves an existing ignore file during concurrent uploads", async () => {
    const upload = (paneId: string) => Promise.all(Array.from({ length: 6 }, (_, index) => post({
      pane_id: paneId,
      content_type: "application/json",
      data_base64: Buffer.from(`{"n":${index}}`).toString("base64"),
      name: `n${index}.json`,
    })));
    const own = await gitProjectPane("ovis-test-image-own-ignore");
    mkdirSync(join(own.cwd, ".ovis"));
    const rules = "# kept by hand\n*.png\n!keep.txt";
    writeFileSync(join(own.cwd, ".ovis", ".gitignore"), rules);
    expect((await upload(own.paneId)).map((res) => res.status)).toEqual(Array(6).fill(200));
    expect(readFileSync(join(own.cwd, ".ovis", ".gitignore"), "utf8")).toBe(rules);
    // the user's own rules still decide: they leave .json files, and the ignore file itself, visible
    expect(gitStatus(own.cwd)).toHaveLength(7);
    if (process.platform === "win32") return; // creating a symlink needs developer mode there
    const outside = mkdtempSync(join(tmpdir(), "ovis-image-rules-"));
    try {
      writeFileSync(join(outside, "rules"), "shared\n");
      for (const target of [join(outside, "rules"), join(outside, "missing")]) {
        const linked = await gitProjectPane("ovis-test-image-linked-ignore");
        mkdirSync(join(linked.cwd, ".ovis"));
        symlinkSync(target, join(linked.cwd, ".ovis", ".gitignore"));
        expect((await upload(linked.paneId)).map((res) => res.status)).toEqual(Array(6).fill(200));
        expect(lstatSync(join(linked.cwd, ".ovis", ".gitignore")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(linked.cwd, ".ovis", ".gitignore"))).toBe(target);
      }
      // nothing was written through either link
      expect(readFileSync(join(outside, "rules"), "utf8")).toBe("shared\n");
      expect(existsSync(join(outside, "missing"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes no ignore file into a OVIS_PASTE_DIR override, even one naming the default folder", async () => {
    const { cwd, paneId } = await gitProjectPane("ovis-test-image-override");
    const previous = process.env["OVIS_PASTE_DIR"];
    const elsewhere = mkdtempSync(join(tmpdir(), "ovis-image-override-"));
    try {
      for (const override of [`  ${elsewhere}  `, join(cwd, ".ovis")]) {
        process.env["OVIS_PASTE_DIR"] = override;
        const answers = await Promise.all([0, 1].map(() => post({ pane_id: paneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 })));
        expect(answers.map((res) => res.status)).toEqual([200, 200]);
        for (const path of await Promise.all(answers.map(pathOf))) expect(path.startsWith(join(override.trim(), "paste-"))).toBe(true);
        expect(existsSync(join(override.trim(), ".gitignore"))).toBe(false);
      }
      // a folder the user picked shows in Git status like any other
      expect(gitStatus(cwd)).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = previous;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("answers an error, not a path, when the ignore file cannot be created", async () => {
    const { cwd, paneId } = await gitProjectPane("ovis-test-image-unwritable");
    mkdirSync(join(cwd, ".ovis"));
    chmodSync(join(cwd, ".ovis"), 0o500);
    try {
      const res = await post({ pane_id: paneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { path?: string }).path).toBeUndefined();
      expect(existsSync(join(cwd, ".ovis", ".gitignore"))).toBe(false);
    } finally {
      chmodSync(join(cwd, ".ovis"), 0o700);
    }
  });

  it("stores a 20 MiB file whole (regression: 413 while the ceiling was 8 MiB)", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
    const res = await post({ pane_id: qaPaneId, content_type: "application/zip", data_base64: bytes.toString("base64"), name: "big.zip" });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(statSync(path).size).toBe(bytes.byteLength);
  });

  it("rejects a 40 MiB file (a 55.9 MB body, under Bun's 64 MiB cap) with 413 and the JSON reason (control)", async () => {
    const oversized = Buffer.alloc(40 * 1024 * 1024, 1).toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: oversized });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("image_too_large");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("counts a streamed body that announces no length and refuses it past the bound (regression: invalid_json on main)", async () => {
    const chunk = new TextEncoder().encode("A".repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(new TextEncoder().encode(`{"pane_id":"${qaPaneId}","content_type":"application/zip","data_base64":"`));
        if (sent++ < 60) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await fetch(`${base()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("image_too_large");
  });

  it("passes a 20 MiB upload through a PC proxy route (regression: the remote refused it above 8 MiB)", async () => {
    const manager = {
      endpoint: () => ({ url: base(), token: "" }),
      trackTerminal: () => () => undefined,
    } as unknown as MachineManager;
    const bytes = Buffer.alloc(20 * 1024 * 1024, 9);
    const res = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/pane/image", {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ pane_id: qaPaneId, content_type: "application/zip", data_base64: bytes.toString("base64"), name: "remote.zip" }),
    }), manager);
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(statSync(path).size).toBe(bytes.byteLength);
  });

  it("rejects empty image data with 400", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_image");
  });

  it("rejects a missing pane_id with 400 and keeps serving", async () => {
    const res = await post({ content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(400);
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("WebSocket /ws", () => {
  /**
   * Uses a workspace this test creates and closes, never one of the user's:
   * attaching starts a real `herdr terminal attach` against a live terminal.
   */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
  });

  it("pushes a snapshot on connect and streams real pty bytes for an attached pane", async () => {
    const paneId = qaPaneId!;
    expect(paneId).toBeTruthy();

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const seen: any[] = [];
    const waitFor = (predicate: (msg: any) => boolean, label: string, ms: number) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
        const listener = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          seen.push(msg);
          if (predicate(msg)) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener as EventListener);
            resolve(msg);
          }
        };
        ws.addEventListener("message", listener as EventListener);
      });

    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const snapshot = await waitFor((m) => m.type === "snapshot", "snapshot", 5000);
    expect(snapshot.snapshot.workspaces.length).toBeGreaterThan(0);

    const streamed = waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "pty-data", 15000);
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 }));
    const frame = await streamed;
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "detach", pane_id: paneId }));
    ws.close();
  }, 30000);

  it("rejects a malformed websocket frame without dropping the connection", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const errored = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error frame within 5s")), 5000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (msg.type === "error") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.send("this is not json");
    const error = await errored;
    expect(error.code).toBe("invalid_json");
    ws.close();
  }, 15000);
});

type CookieWebSocketCtor = new (url: string, options: { headers: { cookie: string } }) => WebSocket;
/** A WS frame as tests read it: the discriminator plus whatever fields they assert on. */
type RecordedFrame = { type: string; [key: string]: unknown };

/** A WS client that records every frame it receives, with a bounded wait for one that matches. */
class RecordingSocket {
  readonly seen: RecordedFrame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String((event as MessageEvent).data)));
    });
  }

  static async connect(url: string): Promise<RecordingSocket> {
    const socket = new RecordingSocket(url);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    // drain the initial snapshot so callers wait only for what they named
    await socket.waitFor((message) => message.type === "snapshot", "snapshot", 10_000);
    return socket;
  }

  waitFor(predicate: (message: RecordedFrame) => boolean, label: string, ms: number): Promise<RecordedFrame> {
    const already = this.seen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<RecordedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        // what did arrive: without it a timeout cannot tell a lost frame from one that came differently
        console.error(`${label}: the last frames received were\n${this.seen.slice(-20).map((frame) => JSON.stringify(frame).slice(0, 300)).join("\n")}`);
        reject(new Error(`${label} not received within ${ms}ms`));
      }, ms);
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as RecordedFrame;
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.ws.removeEventListener("message", listener as EventListener);
        resolve(message);
      };
      this.ws.addEventListener("message", listener as EventListener);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

describe("WebSocket roles and status push", () => {
  /** Own workspace again: the role tests resize a real pty, the exit test kills a real shell. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let exitWorkspaceId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-roles", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (exitWorkspaceId) await herdrRpc("workspace.close", { workspace_id: exitWorkspaceId }).catch(() => undefined);
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId }).catch(() => undefined);
  });

  it("rejects input from a non-attached client and signals readiness to the owner", async () => {
    const owner = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stranger = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      owner.send({ type: "attach", pane_id: qaPaneId!, cols: 100, rows: 30 });
      await owner.waitFor((m) => m.type === "input-ready" && m.pane_id === qaPaneId && m.ready !== false, "input ready", 15_000);
      const captured = join(stateDir, "unicode-input.txt");
      owner.send({ type: "input", pane_id: qaPaneId!, text: `printf '%s' '한글😀' > '${captured}'\r` });
      const deadline = Date.now() + 5000;
      while (!existsSync(captured) && Date.now() < deadline) await Bun.sleep(25);
      expect(readFileSync(captured, "utf8")).toBe("한글😀");
      stranger.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      const error = await stranger.waitFor((m) => m.type === "error", "input rejection", 5000);
      expect(error.code).toBe("input_not_ready");
      owner.send({ type: "detach", pane_id: qaPaneId! });
      owner.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      expect((await owner.waitFor((m) => m.type === "error", "detached rejection", 5000)).code).toBe("input_not_ready");
    } finally { owner.close(); stranger.close(); }
  });

  it("never resizes the shared pty for an observe connection, and read-only frames answer input, keys and resize", async () => {
    const paneId = qaPaneId!;
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);

    try {
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);

      observer.send({ type: "role", mode: "observe" });
      const ack = await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      expect(ack.mode).toBe("observe");

      // an observer attaching a smaller screen must NOT resize the shared pty:
      // the attach answers with the grid to adopt (the operator's 100x30), not its own
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const adopted = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 100,
        "observer adopts geometry",
        5000,
      );
      expect(adopted.rows).toBe(30);
      expect(operator.seen.some((m) => m.type === "pane-geometry")).toBe(false);

      observer.send({ type: "resize", pane_id: paneId, cols: 40, rows: 20 });
      const resizeError = await observer.waitFor((m) => m.type === "error", "resize read_only error", 5000);
      expect(resizeError.code).toBe("read_only");

      observer.send({ type: "input", pane_id: paneId, text: "echo nope" });
      const inputError = await observer.waitFor((m) => m.type === "error", "input read_only error", 5000);
      expect(inputError.code).toBe("read_only");

      observer.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
      const keysError = await observer.waitFor((m) => m.type === "error", "keys read_only error", 5000);
      expect(keysError.code).toBe("read_only");

      // the operator keeps driving the shared grid, and everyone attached hears it
      operator.send({ type: "resize", pane_id: paneId, cols: 120, rows: 40 });
      const geometry = await operator.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "geometry broadcast", 5000);
      expect(geometry.cols).toBe(120);
      expect(geometry.rows).toBe(40);
      await observer.waitFor((m) => m.type === "pane-geometry" && m.cols === 120, "observer hears geometry", 5000);
    } finally {
      operator.close();
      observer.close();
    }
  }, 40_000);

  it("marks only a new attach's replay as replay, with its bytes and ACK offsets unchanged", async () => {
    const paneId = qaPaneId!;
    const url = `ws://localhost:${server.port}/ws`;
    const operator = await RecordingSocket.connect(url);
    const joiner = await RecordingSocket.connect(url);
    const observer = await RecordingSocket.connect(url);
    let rejoined: RecordingSocket | null = null;
    // the shell prints the product, which the typed command line does not contain
    const tag = `replay-origin-${process.pid}`;
    const printed = (product: number) => (m: RecordedFrame) => m.type === "pty-data" && m.pane_id === paneId && String(m.data).includes(`${tag}-${product}`);
    const frames = (socket: RecordingSocket) => socket.seen.filter((m) => m.type === "pty-data" && m.pane_id === paneId);
    /** Each frame's offset is the bytes sent before it plus its own: the replay flag moves none of them. */
    const offsetsFollowBytes = (socket: RecordingSocket) => {
      let sent = 0;
      for (const frame of frames(socket)) {
        sent += Buffer.byteLength(String(frame.data));
        expect((frame.flow as { offset: number }).offset).toBe(sent);
      }
    };
    try {
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await operator.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "operator input-ready", 15_000);
      operator.send({ type: "input", pane_id: paneId, text: `echo ${tag}-$((6*7))\r` });
      const live = await operator.waitFor(printed(42), "operator live output", 15_000);
      expect(live.replay).toBeUndefined();

      // a second view joins: the screen from before comes first, marked, byte for byte the tail
      joiner.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      const replay = await joiner.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "joiner replay", 15_000);
      expect(replay.replay).toBe(true);
      expect(String(replay.data)).toContain(`${tag}-42`);
      const flow = replay.flow as { stream_id: string; offset: number };
      expect(flow.offset).toBe(Buffer.byteLength(String(replay.data)));
      joiner.send({ type: "pty-ack", pane_id: paneId, stream_id: flow.stream_id, offset: flow.offset });
      await joiner.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "joiner input-ready", 5000);

      // the same attach again is idempotent: no second replay, marked or not
      joiner.seen.length = 0;
      joiner.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await joiner.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "idempotent attach input-ready", 5000);
      operator.send({ type: "input", pane_id: paneId, text: `echo ${tag}-$((7*8))\r` });
      await joiner.waitFor(printed(56), "joiner live output", 15_000);
      expect(frames(joiner).length).toBeGreaterThan(0);
      expect(frames(joiner).every((frame) => frame.replay === undefined)).toBe(true);
      expect(joiner.seen.some((m) => m.type === "error" && m.code === "invalid_ack")).toBe(false);
      expect(frames(operator).filter(printed(56)).every((frame) => frame.replay === undefined)).toBe(true);

      // an observer's attach is a new view too, and a reconnect attaches afresh
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      observer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      const watched = await observer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "observer replay", 15_000);
      expect(watched.replay).toBe(true);
      expect(String(watched.data)).toContain(`${tag}-56`);
      joiner.close();
      rejoined = await RecordingSocket.connect(url);
      rejoined.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      const again = await rejoined.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "reconnect replay", 15_000);
      expect(again.replay).toBe(true);
      operator.send({ type: "input", pane_id: paneId, text: `echo ${tag}-$((8*9))\r` });
      await rejoined.waitFor(printed(72), "reconnect live output", 15_000);
      await observer.waitFor(printed(72), "observer live output", 15_000);
      for (const socket of [observer, rejoined]) {
        expect(frames(socket).filter((frame) => frame.replay === true)).toHaveLength(1);
        expect(frames(socket)[0]!.replay).toBe(true);
        offsetsFollowBytes(socket);
      }
    } finally {
      for (const socket of [operator, joiner, observer, rejoined]) socket?.close();
    }
  }, 60_000);

  it("leaves the shared pty's size alone for an attach whose grid the chat lens covers", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-keep-size" });
    const paneId = created.root_pane.pane_id;
    const chat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const otherChat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    // an observer re-attaching is told the grid the shared pty has now
    const grid = async () => {
      observer.seen.length = 0;
      observer.send({ type: "attach", pane_id: paneId, cols: 30, rows: 10 });
      return observer.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "observer geometry", 5000);
    };
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);

      // a phone's chat lens attaches first: the pty starts at the pane's own grid, not 40x20
      chat.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      await chat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "chat pty-data", 15_000);
      const own = await grid();
      expect([own.cols, own.rows]).not.toEqual([40, 20]);
      // and the chat lens is told that grid, to draw the screen it reads as the pty does
      expect(await chat.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "chat geometry", 5000)).toMatchObject({ cols: own.cols, rows: own.rows });

      // another covered attach to the running pty resizes nothing either
      otherChat.send({ type: "attach", pane_id: paneId, cols: 33, rows: 11, keep_size: true });
      await otherChat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "other chat pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: own.cols, rows: own.rows });

      // a terminal lens still drives it: the same check sees a real resize
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: 100, rows: 30 });
    } finally {
      for (const socket of [chat, otherChat, observer, operator]) socket.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  it("applies a resize that arrives while a covered attach is still creating the pty", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-keep-size-switch" });
    const paneId = created.root_pane.pane_id;
    const phone = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the chat lens attaches, and the user switches to the terminal lens before the terminal
      // was looked up: both frames are on the server before the pty exists
      phone.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      phone.send({ type: "resize", pane_id: paneId, cols: 91, rows: 27 });
      // the terminal lens's grid is the pty's, not the pane's own one the covered attach left it at
      expect(await phone.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 91, "the resize applied after creation", 15_000)).toMatchObject({ cols: 91, rows: 27 });
      await phone.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId && m.ready !== false, "attach took", 15_000);
      // regression (fails on main): inspect the rendered screen, not diff-rendered PTY bytes
      phone.send({ type: "input", pane_id: paneId, text: "clear; echo size=$(stty size | tr ' ' x)\r" });
      const deadline = Date.now() + 15_000;
      let screen = "";
      let lastError: unknown;
      while (Date.now() <= deadline) {
        // one read that times out is not the verdict: keep polling until the deadline
        try {
          screen = (await paneRead({ paneId, source: "visible", format: "text", timeoutMs: 1_000 })).text;
        } catch (error) {
          lastError = error;
          continue;
        }
        if (screen.includes("size=27x91")) break;
      }
      expect(screen, `the shell sees the terminal lens's grid (last pane.read error: ${String(lastError)})`).toContain("size=27x91");
    } finally {
      phone.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  // #472: a device that goes back to its chat lens gives the shared pty back to a terminal still
  // showing, without waiting for that terminal's own resize, focus or click
  describe("release-size", () => {
    const ws = () => RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    // the shell's `stty size` goes to a file of its own per ask: herdr redraws the pane's screen as
    // cell updates, so the same answer twice never reads back from the stream. Asked again until the
    // deadline: herdr applies a pty resize to the pane a moment after it.
    let asks = 0;
    const shellSees = async (socket: RecordingSocket, paneId: string, size: string) => {
      const want = size.replace("x", " ");
      let last = "";
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        const file = join(tmpdir(), `ovis-release-size-${process.pid}-${++asks}`);
        socket.send({ type: "input", pane_id: paneId, text: `stty size > ${file}.part && mv ${file}.part ${file}\r` });
        for (const answered = Date.now() + 1000; Date.now() < answered && !existsSync(file);) await Bun.sleep(25);
        if (!existsSync(file)) continue;
        last = readFileSync(file, "utf8").trim();
        rmSync(file, { force: true });
        if (last === want) return;
      }
      throw new Error(`the shell saw "${last}", not "${want}"`);
    };
    const attach = async (socket: RecordingSocket, paneId: string, cols: number, rows: number) => {
      socket.send({ type: "attach", pane_id: paneId, cols, rows });
      await socket.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId && m.ready !== false, "attach took", 15_000);
    };

    it("returns the pty to the desktop's grid when the phone leaves the terminal lens", async () => {
      const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-release-size" });
      const paneId = created.root_pane.pane_id;
      const desktop = await ws();
      const phone = await ws();
      try {
        await attach(desktop, paneId, 120, 40);
        // the phone opens the terminal lens: its viewport takes the shared grid
        await attach(phone, paneId, 53, 33);
        await desktop.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 53, "the phone took the grid", 5000);
        await shellSees(desktop, paneId, "33x53");

        desktop.seen.length = 0;
        phone.send({ type: "release-size", pane_id: paneId });
        // regression (fails on main): the desktop's grid comes back within 1 s, with no desktop frame sent
        expect(await desktop.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "the grid given back", 5000)).toMatchObject({ cols: 120, rows: 40 });
        // regression (fails on main): the shell in the pane sees the desktop's grid
        await shellSees(desktop, paneId, "40x120");
        // control: one server resize for the release, no ping-pong after it
        expect(desktop.seen.filter((m) => m.type === "pane-geometry" && m.pane_id === paneId)).toHaveLength(1);
      } finally {
        desktop.close();
        phone.close();
        await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      }
    }, 60_000);

    it("skips a hidden client's grid when another client releases, leaving the size if nobody shows a terminal", async () => {
      const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-release-size-hidden" });
      const paneId = created.root_pane.pane_id;
      const desktop = await ws();
      const phone = await ws();
      // Use the actual browser client for keepSize, not a hand-written release frame: the bug is
      // that a mounted but hidden terminal used to leave its grid on the server.
      const globals = globalThis as unknown as { window?: unknown };
      const beforeWindow = globals.window;
      globals.window = globalThis;
      const hidden = new HerdrSocket(`ws://localhost:${server.port}/ws`);
      const nextHidden = (matches: (message: import("../shared/protocol.ts").ServerMessage) => boolean) =>
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { off(); reject(new Error("hidden client did not answer")); }, 15_000);
          const off = hidden.on((message) => {
            const ack = message.type === "pty-data" ? hidden.outputAcknowledgement(message) : undefined;
            ack?.();
            if (matches(message)) { clearTimeout(timeout); off(); resolve(); }
          });
        });
      try {
        await attach(desktop, paneId, 120, 40);
        const ready = nextHidden((m) => m.type === "input-ready" && m.pane_id === paneId && m.ready !== false);
        hidden.attach(paneId, 100, 30);
        hidden.connect();
        await ready;
        await desktop.waitFor((m) => m.type === "pane-geometry" && m.cols === 100, "hidden client's initial grid", 5000);
        await attach(phone, paneId, 53, 33);
        await desktop.waitFor((m) => m.type === "pane-geometry" && m.cols === 53, "phone's grid", 5000);
        await shellSees(desktop, paneId, "33x53");

        // An in-band response on the same connection orders keepSize before the phone releases.
        // A nonexistent pending ID changes nothing and sends no terminal input.
        hidden.keepSize(paneId);
        expect(await hidden.pendingAction(paneId, "nonexistent-472", "discard")).toMatchObject({ ok: false });
        desktop.seen.length = 0;
        phone.send({ type: "release-size", pane_id: paneId });
        // regression (fails on main): the hidden 100x30 candidate must not win.
        expect(await desktop.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "remaining terminal's grid", 5000))
          .toMatchObject({ cols: 120, rows: 40 });
        await shellSees(desktop, paneId, "40x120");
        expect(desktop.seen.filter((m) => m.type === "pane-geometry")).toHaveLength(1);

        desktop.seen.length = 0;
        desktop.send({ type: "release-size", pane_id: paneId });
        desktop.send({ type: "ping", id: 47221 });
        await desktop.waitFor((m) => m.type === "pong" && m.id === 47221, "last terminal released", 5000);
        // control: no terminal viewers remain; do not resize to a hidden or Chat grid.
        expect(desktop.seen.filter((m) => m.type === "pane-geometry")).toEqual([]);
        await shellSees(desktop, paneId, "40x120");
      } finally {
        hidden.close();
        globals.window = beforeWindow;
        desktop.close();
        phone.close();
        await workspaceClose(created.workspace.workspace_id);
      }
    }, 60_000);

    it("keeps a grid released during attach creation out of the fallback candidates", async () => {
      const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-release-size-creating" });
      const paneId = created.root_pane.pane_id;
      const hidden = await ws();
      const phone = await ws();
      try {
        // Back-to-back on the same connection: release lands during the initial terminal lookup.
        hidden.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        hidden.send({ type: "release-size", pane_id: paneId });
        hidden.send({ type: "ping", id: 47222 });
        await hidden.waitFor((m) => m.type === "pong" && m.id === 47222, "release processed during creation", 5000);
        await hidden.waitFor((m) => m.type === "input-ready", "hidden attach completed", 15_000);
        await attach(phone, paneId, 53, 33);
        await hidden.waitFor((m) => m.type === "pane-geometry" && m.cols === 53, "phone grid", 5000);
        await shellSees(phone, paneId, "33x53");
        hidden.seen.length = 0;
        phone.send({ type: "release-size", pane_id: paneId });
        phone.send({ type: "ping", id: 47223 });
        await phone.waitFor((m) => m.type === "pong" && m.id === 47223, "phone release processed", 5000);
        // regression (fails on main): the completed attach must not revive a released grid.
        expect(hidden.seen.filter((m) => m.type === "pane-geometry")).toEqual([]);
        await shellSees(phone, paneId, "33x53");
      } finally {
        hidden.close();
        phone.close();
        await workspaceClose(created.workspace.workspace_id);
      }
    }, 60_000);

    it("never overwrites a resize another client sends after the release", async () => {
      const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-release-size-race" });
      const paneId = created.root_pane.pane_id;
      const desktop = await ws();
      const phone = await ws();
      const third = await ws();
      try {
        await attach(desktop, paneId, 120, 40);
        await attach(phone, paneId, 53, 33);
        // the third client watches from the chat lens until it resizes
        third.send({ type: "attach", pane_id: paneId, cols: 30, rows: 10, keep_size: true });
        await third.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId && m.ready !== false, "third attach took", 15_000);
        await desktop.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 53, "the phone took the grid", 5000);

        desktop.seen.length = 0;
        phone.send({ type: "release-size", pane_id: paneId });
        third.send({ type: "resize", pane_id: paneId, cols: 100, rows: 30 });
        await desktop.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 100, "the third client's resize", 5000);
        // control: the pty ends at the later resize, whichever of the two frames the server read first
        await shellSees(third, paneId, "30x100");
        // control: at most the release's own resize before the third client's, nothing after it
        const grids = desktop.seen.filter((m) => m.type === "pane-geometry" && m.pane_id === paneId);
        expect(grids.length).toBeLessThanOrEqual(2);
        expect(grids.at(-1)).toMatchObject({ cols: 100, rows: 30 });
      } finally {
        for (const socket of [desktop, phone, third]) socket.close();
        await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      }
    }, 60_000);

    it("ignores a release from a client that never drove the grid, as an older server ignores the frame", async () => {
      const created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-release-size-noop" });
      const paneId = created.root_pane.pane_id;
      const desktop = await ws();
      const chat = await ws();
      try {
        await attach(desktop, paneId, 120, 40);
        chat.send({ type: "attach", pane_id: paneId, cols: 53, rows: 33, keep_size: true });
        await chat.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId && m.ready !== false, "chat attach took", 15_000);
        desktop.seen.length = 0;
        chat.seen.length = 0;
        chat.send({ type: "release-size", pane_id: paneId });
        // also for a pane this connection never attached
        chat.send({ type: "release-size", pane_id: "w-nonexistent:p1" });
        chat.send({ type: "ping", id: 472 });
        // control (passes on main): the connection stays open and answers, with no error frame
        await chat.waitFor((m) => m.type === "pong" && m.id === 472, "pong after release-size", 5000);
        expect(chat.seen.filter((m) => m.type === "error")).toEqual([]);
        // control (passes on main): the grid stays the desktop's
        await shellSees(desktop, paneId, "40x120");
        expect(desktop.seen.filter((m) => m.type === "pane-geometry")).toEqual([]);
      } finally {
        desktop.close();
        chat.close();
        await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      }
    }, 60_000);
  });

  it("rejects an unknown role mode with an in-band error", async () => {
    const client = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      client.send({ type: "role", mode: "wat" });
      const error = await client.waitFor((m) => m.type === "error", "invalid_role error", 5000);
      expect(error.code).toBe("invalid_role");
    } finally {
      client.close();
    }
  }, 15_000);

  it("pushes pane-status and pane-exited for a pane nobody is attached to", async () => {
    const paneId = qaPaneId!;
    const watcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the collector subscribed to this pane when it was created; prove it by pushing
      // status changes through herdr itself and seeing the frames. herdr tears down a
      // subscription batch that references a pane which vanished mid-reconcile, so the
      // collector may briefly re-subscribe - retry the report (alternating states, so
      // each is a real change) until the frame arrives instead of trusting the clock
      let seen = false;
      for (let attempt = 0; attempt < 8 && !seen; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: paneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        seen = await watcher
          .waitFor(
            (m) => m.type === "pane-status" && m.pane_id === paneId && m.agent_status === (attempt % 2 === 0 ? "blocked" : "working"),
            "unattached pane-status",
            2_500,
          )
          .then(() => true)
          .catch(() => false);
      }
      expect(seen).toBeTrue();

      // a pane ending while unattached pushes pane-exited
      const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
        "workspace.create",
        { label: "ovis-test-exit", cwd: "/tmp", focus: false },
      );
      exitWorkspaceId = created.workspace.workspace_id;
      const exitPaneId = created.root_pane.pane_id;
      // the collector picks a brand-new pane up via pane.created -> reconcile, which is
      // debounced: retry the status report (alternating states, so each is a real
      // change) until the frame proves the subscription is live - no clock-waiting
      let subscribed = false;
      for (let attempt = 0; attempt < 8 && !subscribed; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: exitPaneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        subscribed = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === exitPaneId, "exit pane subscribed", 1_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(subscribed).toBeTrue();
      await herdrRpc("pane.send_text", { pane_id: exitPaneId, text: "exit\r" });
      const exited = await watcher.waitFor(
        (m) => m.type === "pane-exited" && m.pane_id === exitPaneId,
        "unattached pane-exited",
        10_000,
      );
      expect(exited.type).toBe("pane-exited");
    } finally {
      watcher.close();
    }
  }, 40_000);
});

describe("WebSocket observer-first attach", () => {
  /** Own pane: the observer must be the one that creates the attachment. */
  let observeWorkspaceId: string | null = null;
  let observePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-observe", cwd: "/tmp", focus: false },
    );
    observeWorkspaceId = created.workspace.workspace_id;
    observePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (observeWorkspaceId) await herdrRpc("workspace.close", { workspace_id: observeWorkspaceId }).catch(() => undefined);
  });

  it("sizes a PTY an observe connection creates from the pane, never from the observer's grid", async () => {
    // observer-FIRST attach: nobody holds the attachment, so the observer's connect
    // spawns the shared pty. The user's named scenario (a phone opens the pane first)
    // must not seed the pty with the phone's viewport.
    const paneId = observePaneId!;
    const rectOf = async (): Promise<{ width: number; height: number } | null> => {
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      return snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    };
    const rectBefore = await rectOf();
    expect(rectBefore).not.toBeNull();

    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const geometry = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId,
        "observer geometry",
        15_000,
      );
      // the spawned pty carries the pane's grid, not the observer's 40x20
      expect(geometry.cols).toBe(rectBefore!.width);
      expect(geometry.rows).toBe(rectBefore!.height);
      // herdr's layout is untouched either way
      expect(await rectOf()).toEqual(rectBefore);
    } finally {
      observer.close();
    }
  }, 30_000);
});

describe("WebSocket concurrent attach", () => {
  /** A pane nobody holds yet: the race is in CREATING the attachment. */
  let raceWorkspaceId: string | null = null;
  let racePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-race", cwd: "/tmp", focus: false },
    );
    raceWorkspaceId = created.workspace.workspace_id;
    racePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (raceWorkspaceId) await herdrRpc("workspace.close", { workspace_id: raceWorkspaceId }).catch(() => undefined);
  });

  it("shares one pty between clients whose attaches to the same pane race", async () => {
    const paneId = racePaneId!;
    const first = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const second = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: both attaches are in flight before either resolves the terminal
      first.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      second.send({ type: "attach", pane_id: paneId, cols: 120, rows: 40 });
      await first.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "first pty-data", 15_000);
      await second.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "second pty-data", 15_000);

      // one attachment means one client set: a resize reaches both. Two attachments
      // would leave one client on an orphaned record that never hears it.
      first.send({ type: "resize", pane_id: paneId, cols: 90, rows: 25 });
      await first.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "first hears resize", 5000);
      await second.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "second hears resize", 5000);
    } finally {
      first.close();
      second.close();
    }
  }, 40_000);
});

describe("WebSocket client leaving mid-attach", () => {
  /** One pane per trigger, so neither test inherits the other's attachment. */
  const leaveWorkspaceIds: string[] = [];

  async function createLeavePane(label: string): Promise<{ paneId: string; terminalId: string }> {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label, cwd: "/tmp", focus: false },
    );
    leaveWorkspaceIds.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as { terminal_id?: string } | undefined;
    expect(pane?.terminal_id).toBeTruthy();
    return { paneId, terminalId: pane!.terminal_id! };
  }

  /** The leaked resource itself: a live `herdr terminal attach` (or its sidecar) on this terminal. */
  function attachProcessCount(terminalId: string): number {
    const found = Bun.spawnSync(["pgrep", "-f", `terminal attach ${terminalId}`]);
    return found.stdout.toString().split("\n").filter(Boolean).length;
  }

  async function waitForAttachGone(terminalId: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (attachProcessCount(terminalId) > 0) {
      if (Date.now() > deadline) throw new Error(`attach on ${terminalId} still running ${ms}ms after its last client left`);
      await Bun.sleep(50);
    }
  }

  afterAll(async () => {
    for (const workspaceId of leaveWorkspaceIds) {
      await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    }
  });

  it("never pins the pty for a client that disconnects before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("ovis-test-leave-close");
    expect(attachProcessCount(terminalId)).toBe(0);
    const leaver = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: the close lands while the attach is still looking up the terminal
      leaver.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      leaver.close();
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
    } finally {
      stayer.close();
    }
    // the last live client left, so nothing may keep the attach running
    await waitForAttachGone(terminalId, 5000);
  }, 40_000);

  it("never pins the pty for a client that detaches before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("ovis-test-leave-detach");
    expect(attachProcessCount(terminalId)).toBe(0);
    const switcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // switching panes fast: the detach lands while the attach is still looking up the terminal
      switcher.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      switcher.send({ type: "detach", pane_id: paneId });
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
      stayer.close();
      // the switcher is still connected but detached: it must not keep the attach running
      await waitForAttachGone(terminalId, 5000);
      expect(switcher.seen.some((m) => m.type === "pty-data" && m.pane_id === paneId)).toBe(false);
    } finally {
      switcher.close();
      stayer.close();
    }
  }, 40_000);
});

/**
 * Bun's WebSocket client sends request headers, but this project compiles with lib.dom,
 * whose WebSocket type only knows subprotocols (bun-types steps aside via
 * UseLibDomIfAvailable). Reaching the real capability through a guard keeps the test
 * honest: if Bun ever stopped sending the header, the server refuses the upgrade and
 * the test fails instead of silently passing.
 */
function takesCookieHeader(value: unknown): value is CookieWebSocketCtor {
  return typeof value === "function";
}

function connectWithCookie(url: string, cookie: string): WebSocket {
  const ctor: unknown = globalThis.WebSocket;
  if (!takesCookieHeader(ctor)) throw new Error("no WebSocket constructor in this runtime");
  return new ctor(url, { headers: { cookie } });
}

describe("web push", () => {
  /** A fake push service that decrypts like a device: see push.fake.ts. */
  let fake: FakePushService;
  let pushWorkspaceId: string | null = null;
  let pushPaneId: string | null = null;

  const postJson = (path: string, body: unknown, method = "POST") =>
    fetch(`${base()}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fake = await startFakePushService();
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "ovis-test-push", cwd: "/tmp", focus: false },
    );
    pushWorkspaceId = created.workspace.workspace_id;
    pushPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE").catch(() => undefined);
    fake.stop();
    if (pushWorkspaceId) await herdrRpc("workspace.close", { workspace_id: pushWorkspaceId }).catch(() => undefined);
  });

  it("hands out its VAPID key and refuses what is not a subscription", async () => {
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(Buffer.from(key.public_key, "base64url").length).toBe(65);

    const malformed = await postJson("/api/push/subscribe", { subscription: { endpoint: fake.subscription.endpoint, keys: {} } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiError).error.code).toBe("invalid_subscription");

    const wrongMethod = await fetch(`${base()}/api/push/subscribe`);
    expect(wrongMethod.status).toBe(400);
    expect(((await wrongMethod.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("confirms a new device with a push it can decrypt, and forgets it on request", async () => {
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    expect((await postJson("/api/push/test", { endpoint: fake.subscription.endpoint })).status).toBe(204);
    const confirmation = await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect(confirmation.payload.pane_id).toBeNull();
    expect(confirmation.vapidValid).toBe(true);
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(confirmation.vapidKey).toBe(key.public_key);

    expect((await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE")).status).toBe(204);
    const gone = await postJson("/api/push/test", { endpoint: fake.subscription.endpoint });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as ApiError).error.code).toBe("subscription_not_found");
  });

  // regression (fails on main): an endpoint the push service retired is refused, never-known stays not found (#1038)
  it.each([404, 410])("answers subscription_gone on the first test when the push service returns %i", async (status) => {
    const retiring = await startFakePushService();
    try {
      expect((await postJson("/api/push/subscribe", { subscription: retiring.subscription })).status).toBe(204);
      retiring.answerWith(status);
      const first = await postJson("/api/push/test", { endpoint: retiring.subscription.endpoint });
      expect(first.status).toBe(410);
      expect(((await first.json()) as ApiError).error.code).toBe("subscription_gone");
      const again = await postJson("/api/push/subscribe", { subscription: retiring.subscription });
      expect(again.status).toBe(410);
      expect(((await again.json()) as ApiError).error.code).toBe("subscription_gone");
      const tested = await postJson("/api/push/test", { endpoint: retiring.subscription.endpoint });
      expect(tested.status).toBe(410);
      expect(((await tested.json()) as ApiError).error.code).toBe("subscription_gone");
      // control
      const unknown = await postJson("/api/push/test", { endpoint: "https://push.example/never-known" });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as ApiError).error.code).toBe("subscription_not_found");
    } finally {
      retiring.stop();
    }
  });

  it("pushes a live pane's status change to a subscribed device", async () => {
    const paneId = pushPaneId!;
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    // same retry as the pane-status test: the collector may still be re-subscribing to
    // the new pane, so alternate real changes until one lands as a push
    let pushed = null;
    for (let attempt = 0; attempt < 8 && !pushed; attempt += 1) {
      const state = attempt % 2 === 0 ? "blocked" : "working";
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
      if (state !== "blocked") continue;
      pushed = await fake
        .waitFor((push) => push.payload.pane_id === paneId, "status push", 2_500)
        .catch(() => null);
    }
    expect(pushed).not.toBeNull();
    expect(pushed!.payload.body).toBe("waiting for your input");
    expect(pushed!.payload.tag).toBe(`herdr-pane-${paneId}`);
    expect(pushed!.urgency).toBe("high");
    expect(pushed!.vapidValid).toBe(true);
  }, 40_000);

  it("sends no device an alert while a connected page says it is in use, and alerts again once it is not (#751)", async () => {
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let dir: string | undefined;
    let device: FakePushService | undefined;
    let bridge: ReturnType<typeof createServer> | undefined;
    let page: RecordingSocket | undefined;
    try {
      created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-push-presence" });
      const paneId = created.root_pane.pane_id;
      dir = mkdtempSync(join(tmpdir(), "ovis-push-presence-"));
      device = await startFakePushService();
      bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: dir, machines: false, pushLoopbackHttp: true,
        alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const subscribe = await fetch(`http://127.0.0.1:${bridge.port}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      page = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      // a connection's frames are handled in order: the role-ack says the presence before it was read
      const tell = async (active: boolean): Promise<void> => {
        page!.seen.length = 0;
        page!.send({ type: "presence", active });
        page!.send({ type: "role", mode: "interact" });
        await page!.waitFor((message) => message.type === "role-ack", "role-ack after presence", 5_000);
      };
      const report = async (state: "working" | "blocked"): Promise<boolean> => {
        // only a frame this report caused may answer it
        page!.seen.length = 0;
        await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
        return page!.waitFor((message) => message.type === "pane-status" && message.pane_id === paneId && message.agent_status === state,
          `${state} on the page`, 2_500).then(() => true).catch(() => false);
      };
      const alerts = () => device!.received.filter((push) => push.payload.pane_id === paneId);

      await tell(true);
      // the collector may still be subscribing to the new pane: alternate until a blocked lands
      let blocked = false;
      for (let attempt = 0; attempt < 8 && !blocked; attempt++) {
        await report("working");
        blocked = await report("blocked");
      }
      expect(blocked).toBe(true);
      await bridge.alertsSettled();
      expect(alerts()).toHaveLength(0);

      await tell(false);
      expect(await report("working")).toBe(true);
      expect(await report("blocked")).toBe(true);
      const pushed = await device.waitFor((push) => push.payload.pane_id === paneId, "alert once no page is in use", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");

      // a page that leaves without saying so no longer holds the alerts back
      await tell(true);
      page.close();
      page = undefined;
      const watcher = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      page = watcher;
      // the server reads the close on its own time: alternate until an alert comes, which only
      // happens once the closed page stopped holding them back
      let alerted = false;
      for (let attempt = 0; attempt < 8 && !alerted; attempt++) {
        expect(await report("working")).toBe(true);
        expect(await report("blocked")).toBe(true);
        await bridge.alertsSettled();
        alerted = alerts().length === 2;
      }
      expect(alerted).toBe(true);
    } finally {
      page?.close();
      bridge?.stop();
      device?.stop();
      if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports a Codex unknown after work as done over WS and HTTP and delivers its completion push", async () => {
    // Exercise the real collector -> CompletionTracker -> PushService path using
    // manually reported statuses in owned panes. No Codex request or real device.
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let probe: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let dir: string | undefined;
    let cleanupDevice: FakePushService | undefined;
    let bridge: ReturnType<typeof createServer> | undefined;
    let watcher: RecordingSocket | undefined;
    try {
      created = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-codex-finish" });
      probe = await workspaceCreate({ cwd: tmpdir(), label: "ovis-test-codex-probe" });
      const paneId = created.root_pane.pane_id;
      const probeId = probe.root_pane.pane_id;
      dir = mkdtempSync(join(tmpdir(), "ovis-codex-finish-"));
      const device = await startFakePushService();
      cleanupDevice = device;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "unknown" });
      bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: dir, machines: false, pushLoopbackHttp: true,
        alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const origin = `http://127.0.0.1:${bridge.port}`;
      watcher = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      const subscribe = await fetch(`${origin}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription, alerts: { input: false, done: "always" } }),
      });
      expect(subscribe.status).toBe(204);

      // Prove the subscription is live before changing the watched pane exactly
      // once. Alternating a separate probe does not fabricate its work history.
      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt++) {
        const state = attempt % 2 === 0 ? "working" : "blocked";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher.waitFor((message) => message.type === "pane-status" && message.pane_id === probeId && message.agent_status === state,
          "Codex regression probe", 2_500).then(() => true).catch(() => false);
      }
      expect(live).toBe(true);

      let finishId = 0;
      let finishEpoch: string | undefined;
      const report = async (agent: string, state: string, expected: string) => {
        watcher!.seen.length = 0;
        const frameReady = watcher!.waitFor((message) => message.type === "pane-status" && message.pane_id === paneId && message.agent_status === expected,
          `${agent}/${state} presented as ${expected}`, 5_000);
        await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent, state });
        const frame = await frameReady;
        if (frame.type !== "pane-status" || typeof frame.finish_epoch !== "string") throw new Error("expected status frame with epoch");
        if (expected === "done") finishId++;
        expect(frame.finish_id).toBe(finishId);
        expect(typeof frame.finish_epoch).toBe("string");
        if (finishEpoch) expect(frame.finish_epoch).toBe(finishEpoch);
        finishEpoch = frame.finish_epoch;
        const raw = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
        // herdr itself may promote an unfocused idle after work to done.
        const rawStatus = raw.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
        if (state === "idle") expect(rawStatus === "idle" || rawStatus === "done").toBe(true);
        else expect(rawStatus).toBe(state);
        const shown = await (await fetch(`${origin}/api/session`)).json() as { snapshot: SessionSnapshot };
        expect(shown.snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
        expect(shown.snapshot.agents.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
        expect(shown.snapshot.finish_epoch).toBe(finishEpoch);
        expect(shown.snapshot.panes.find((pane) => pane.pane_id === paneId)?.finish_id).toBe(finishId);
      };

      for (let turn = 0; turn < 2; turn++) {
        await report("codex", "working", "working");
        await report("codex", "unknown", "done");
        await device.waitFor((message) => message.payload.pane_id === paneId &&
          device.received.filter((received) => received.payload.pane_id === paneId).length === turn + 1,
          "Codex completion push", 5_000);
      }
      const finishes = () => device.received.filter((message) => message.payload.pane_id === paneId);
      expect(finishes()).toHaveLength(2);
      expect(finishes().every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

      // The same unknown status after an identity handoff is still ongoing work.
      await report("pi", "working", "working");
      await report("claude", "unknown", "working");
      expect(finishes()).toHaveLength(2);
      await report("claude", "idle", "done");
      await device.waitFor((message) => message.payload.pane_id === paneId && finishes().length === 3, "handoff completion push", 5_000);
      expect(finishes()).toHaveLength(3);
    } finally {
      if (bridge && cleanupDevice) await fetch(`http://127.0.0.1:${bridge.port}/api/push/subscribe`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: cleanupDevice.subscription.endpoint }),
      }).catch(() => undefined);
      watcher?.close();
      bridge?.stop();
      cleanupDevice?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      if (probe) await workspaceClose(probe.workspace.workspace_id).catch(() => undefined);
    }
  }, 40_000);

  it("alerts on the very first change after a restart, measured against herdr's snapshot", async () => {
    // A server restart must not cost the first alert: the collector seeds each pane's
    // status from its startup snapshot. Pane `watched` is already working when the new
    // server starts; pane `probe` shares the status subscription and proves it is live
    // before `watched` changes exactly once.
    const createPane = async (label: string) =>
      herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", {
        label,
        cwd: "/tmp",
        focus: false,
      });
    const watched = await createPane("ovis-test-push-restart");
    const probe = await createPane("ovis-test-push-probe");
    const watchedId = watched.root_pane.pane_id;
    const probeId = probe.root_pane.pane_id;
    const restartDir = mkdtempSync(join(tmpdir(), "ovis-restart-"));
    const device = await startFakePushService();
    let restarted: { port: number; stop: () => void } | null = null;
    let watcher: RecordingSocket | null = null;
    try {
      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "working" });
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(before.panes.find((pane) => pane.pane_id === watchedId)?.agent_status).toBe("working");

      restarted = createServer({ port: 0, stateDir: restartDir, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
      const subscribe = await fetch(`http://localhost:${restarted.port}/api/push/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      watcher = await RecordingSocket.connect(`ws://localhost:${restarted.port}/ws`);

      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt += 1) {
        const state = attempt % 2 === 0 ? "working" : "idle";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === probeId && m.agent_status === state, "probe status", 2_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(live).toBeTrue();

      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "blocked" });
      await watcher.waitFor((m) => m.type === "pane-status" && m.pane_id === watchedId, "watched status", 5_000);
      const pushed = await device.waitFor((push) => push.payload.pane_id === watchedId, "first push after restart", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");
    } finally {
      watcher?.close();
      restarted?.stop();
      device.stop();
      rmSync(restartDir, { recursive: true, force: true });
      for (const created of [watched, probe]) {
        await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => undefined);
      }
    }
  }, 60_000);
});

describe("pairing and identity", () => {
  /** no token: the gate is where the request comes from, who Tailscale says it is, or a paired device's cookie */
  const OWNER = "owner@example.com";
  let open: { port: number; stop: () => void };
  const openState = mkdtempSync(join(tmpdir(), "herdr-pairing-"));
  beforeAll(() => { open = createServer({ port: 0, stateDir: openState, tailscaleOwner: OWNER }); });
  afterAll(() => { open?.stop(); rmSync(openState, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${open.port}`;
  /** as if `tailscale serve` or a reverse proxy had forwarded it: the test client is on loopback, like a proxy */
  const proxied = (login?: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": "100.64.0.9", ...(login ? { "tailscale-user-login": login } : {}), ...extra });
  const auth = async (headers: Record<string, string> = {}) => ((await (await fetch(`${base()}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
  const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
  let cookie = "";
  let deviceId = "";

  it("lets this PC in, and not a proxied request with no login while the PC's Tailscale login is known", async () => {
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    // tailscale serve names no person for a tagged node: it pairs, even before the first device
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
  });

  it("does not take a proxied request for this PC when the proxy sends no X-Forwarded-For", async () => {
    // a proxy that keeps the browser's Host, or sends only another forwarding header
    expect(await auth({ host: "app.example.test" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: { host: "app.example.test" } })).status).toBe(401);
    for (const name of ["x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "via"]) {
      expect(await auth({ [name]: "https" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    }
    // this PC under its other names is still this PC
    for (const host of [`localhost:${open.port}`, `herdr.localhost:${open.port}`, "localhost:5173"]) {
      expect(await auth({ host })).toMatchObject({ authenticated: true, via: "local" });
    }
  });

  it("trusts the PC's own Tailscale login and refuses another", async () => {
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("Owner@Example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
    const refused = await fetch(`${base()}/api/session`, { headers: proxied("someone@example.com") });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ApiError).error.code).toBe("other_user");
  });

  it("regression: refuses identity headers without a single tailnet forwarded address", async () => {
    for (const forwardedFor of [null, "127.0.0.1", "203.0.113.50", "100.64.0.9, 100.64.0.10"]) {
      const headers = { "tailscale-user-login": OWNER, ...(forwardedFor === null ? {} : { "x-forwarded-for": forwardedFor }) };
      const response = await fetch(`${base()}/api/devices`, { headers });
      expect(response.status).toBe(401);
      expect(((await response.json()) as ApiError).error.code).toBe("unauthorized");
      expect(await auth(headers)).toMatchObject({ authenticated: false, reason: "pairing_required" });
    }
    // control: Serve may forward either tailnet address family.
    expect((await fetch(`${base()}/api/devices`, { headers: proxied(OWNER, { "x-forwarded-for": "fd7a:115c:a1e0::1" }) })).status).toBe(200);
  });

  it("lets the owner's own device in with no login header, where serve is the only ingress and one login owns the tailnet", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-sole-user-"));
    const savedOwner = process.env["OVIS_TAILSCALE_OWNER"];
    const savedServeOnly = process.env["OVIS_TAILSCALE_SERVE_ONLY"];
    delete process.env["OVIS_TAILSCALE_OWNER"];
    // what `tailscale status --json` says for the reported tailnet: one login, every node untagged
    const NODE = "denisss-macbook-pro-m1.tail5cc90b.ts.net";
    const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NODE}.`, UserID: 7, TailscaleIPs: ["100.101.102.103"] }, Peer: { phone: { DNSName: "phone.tail5cc90b.ts.net.", UserID: 7 } }, User: { "7": { LoginName: OWNER } } });
    const tailnet = new TailnetIdentitySource(async () => status);
    process.env["OVIS_TAILSCALE_SERVE_ONLY"] = "1";
    const sole = createServer({ port: 0, stateDir: state, tailnet });
    if (savedServeOnly === undefined) delete process.env["OVIS_TAILSCALE_SERVE_ONLY"]; else process.env["OVIS_TAILSCALE_SERVE_ONLY"] = savedServeOnly;
    const off = createServer({ port: 0, stateDir: state, tailscaleServeOnly: false, tailnet });
    const named = createServer({ port: 0, stateDir: state, tailscaleOwner: OWNER, tailscaleServeOnly: true, tailnet });
    const other = createServer({ port: 0, stateDir: state, tailscaleOwner: "named@example.com", tailscaleServeOnly: true, tailnet });
    const at = async (port: number, headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
    try {
      // the captain's phone: tailscale serve proxied it, names no person, and the address is this PC's Tailscale name
      const phone = { ...proxied(), host: NODE };
      expect(await at(sole.port, phone)).toMatchObject({ authenticated: true, via: "tailscale" });
      expect((await fetch(`http://127.0.0.1:${sole.port}/api/session`, { headers: phone })).status).not.toBe(401);
      // the same name in another case, or this PC's tailnet address, is the same PC
      expect(await at(sole.port, { ...proxied(), host: NODE.toUpperCase() })).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(sole.port, { ...proxied(), host: "100.101.102.103:7317" })).toMatchObject({ authenticated: true, via: "tailscale" });
      // a rebinding page or a public domain forwarded here presents its own Host, and pairs
      expect(await at(sole.port, { ...proxied(), host: "evil.example:7317" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect((await fetch(`http://127.0.0.1:${sole.port}/api/session`, { headers: { ...proxied(), host: "evil.example:7317" } })).status).toBe(401);
      // and the floor stays where it was: another login, Funnel and a LAN client gain nothing
      expect(await at(sole.port, { ...phone, "tailscale-user-login": "someone@example.com" })).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(sole.port, { ...phone, "tailscale-funnel-request": "?1" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect(await at(sole.port, { ...phone, "tailscale-user-login": OWNER })).toMatchObject({ authenticated: true, via: "tailscale" });
      // regression: a rejected identity is not an absent identity, even at this PC's Host.
      expect(await at(sole.port, { ...phone, "tailscale-user-login": OWNER, "x-forwarded-for": "127.0.0.1" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
      // where the operator did not declare serve the only ingress, the same request pairs, with or without the tailnet's name as Host
      expect(await at(off.port, proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect(await at(off.port, phone)).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect((await fetch(`http://127.0.0.1:${off.port}/api/session`, { headers: proxied() })).status).toBe(401);
      // a named owner is read the same way: the sole login it matches is let in, another name is not
      expect(await at(named.port, phone)).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(other.port, phone)).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      sole.stop();
      off.stop();
      named.stop();
      other.stop();
      if (savedOwner === undefined) delete process.env["OVIS_TAILSCALE_OWNER"]; else process.env["OVIS_TAILSCALE_OWNER"] = savedOwner;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("refuses a serve request inside the cache's TTL once a node is tagged since the cache was read", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-stale-identity-"));
    const savedOwner = process.env["OVIS_TAILSCALE_OWNER"];
    delete process.env["OVIS_TAILSCALE_OWNER"];
    const NODE = "stale-pc.example.ts.net";
    const self = { DNSName: `${NODE}.`, TailscaleIPs: ["100.101.102.103"], UserID: 7 };
    const sole = JSON.stringify({ BackendState: "Running", Self: self, User: { "7": { LoginName: OWNER } } });
    const tagged = JSON.stringify({ BackendState: "Running", Self: self, Peer: { node: { UserID: 7, Tags: ["tag:server"] } }, User: { "7": { LoginName: OWNER } } });
    let read = 0;
    const tailnet = new TailnetIdentitySource(() => Promise.resolve(read++ === 0 ? sole : tagged));
    await tailnet.freshIdentity(NODE);
    const serveOnly = createServer({ port: 0, stateDir: state, tailscaleServeOnly: true, tailnet });
    try {
      const auth = ((await (await fetch(`http://127.0.0.1:${serveOnly.port}/api/health?scope=bridge`, { headers: { ...proxied(), host: NODE } })).json()) as { auth: HealthAuth }).auth;
      expect(auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      serveOnly.stop();
      if (savedOwner === undefined) delete process.env["OVIS_TAILSCALE_OWNER"]; else process.env["OVIS_TAILSCALE_OWNER"] = savedOwner;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("regression: lets the owner's login in as soon as Tailscale finishes starting, not five minutes after a boot", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-boot-identity-"));
    const savedOwner = process.env["OVIS_TAILSCALE_OWNER"];
    delete process.env["OVIS_TAILSCALE_OWNER"];
    // a PC that paired a device before: the gate is closed to strangers
    writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [] }));
    // at boot the server asks before tailscaled has logged in: no user yet; every later read is Running
    const starting = JSON.stringify({ BackendState: "NoState", Self: { DNSName: "" } });
    const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.example.ts.net.", UserID: 7, TailscaleIPs: ["100.101.102.103"] }, User: { "7": { LoginName: OWNER } } });
    let reads = 0;
    const tailnet = new TailnetIdentitySource(async () => reads++ === 0 ? starting : running);
    await tailnet.freshIdentity(null);
    const booted = createServer({ port: 0, stateDir: state, tailnet });
    const at = async (headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${booted.port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
    // the owner's phone asks a few seconds after the boot read, once tailscaled is up
    const start = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => start + 3_000);
    try {
      expect(await at(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
      // once the login is known it is kept for the cache's life: later polls read nothing
      const settled = reads;
      expect(await at(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(reads).toBe(settled);
      // a stranger still pairs
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      clock.mockRestore();
      booted.stop();
      if (savedOwner === undefined) delete process.env["OVIS_TAILSCALE_OWNER"]; else process.env["OVIS_TAILSCALE_OWNER"] = savedOwner;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("takes the login named in OVIS_TAILSCALE_OWNER for the PC's own, as a tagged node needs", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-named-owner-"));
    const before = process.env["OVIS_TAILSCALE_OWNER"];
    process.env["OVIS_TAILSCALE_OWNER"] = " named@example.com ";
    const named = createServer({ port: 0, stateDir: state });
    try {
      const at = async (headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${named.port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
      expect(await at(proxied("named@example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      named.stop();
      if (before === undefined) delete process.env["OVIS_TAILSCALE_OWNER"]; else process.env["OVIS_TAILSCALE_OWNER"] = before;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("never treats a Funnel request as open", async () => {
    expect(await auth(proxied(undefined, { "tailscale-funnel-request": "?1" }))).toMatchObject({ authenticated: false, reason: "pairing_required" });
  });

  it("pairs a device with a code from this PC, and the gate closes for strangers", async () => {
    expect((await fetch(`${base()}/api/devices/pair/start`, { method: "POST" })).status).toBe(403); // the mutation guard
    const started = await fetch(`${base()}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(started.status).toBe(200);
    const { code } = (await started.json()) as { code: string; expires_at: string };
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: code === "000000" ? "111111" : "000000", label: "x" }) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiError).error.code).toBe("invalid_code");
    const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code, label: "  Test  phone " }) });
    expect(paired.status).toBe(204);
    const setCookie = paired.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^ovis_device=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/);
    cookie = setCookie.split(";")[0]!;
    // the device is in, from anywhere; a stranger no longer is; this PC still is
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: true, via: "device" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    const list = (await (await fetch(`${base()}/api/devices`, { headers: { ...proxied(), cookie } })).json()) as { devices: Array<{ id: string; label: string; current: boolean }> };
    expect(list.devices.map((d) => [d.label, d.current])).toEqual([["Test phone", true]]);
    deviceId = list.devices[0]!.id;
    expect(readFileSync(join(openState, "devices.json"), "utf8")).not.toContain(cookie.split("=")[1]);
  });

  it("renames and revokes a device; signing out drops its cookie", async () => {
    const renamed = await fetch(`${base()}/api/devices/${deviceId}`, { method: "PATCH", headers: guard, body: JSON.stringify({ label: "Kitchen iPad" }) });
    expect(((await renamed.json()) as { label: string }).label).toBe("Kitchen iPad");
    const out = await fetch(`${base()}/api/auth`, { method: "DELETE", headers: { cookie } });
    expect(out.headers.get("set-cookie") ?? "").toContain("ovis_device=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(204);
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(404);
    // the revoked device is out, and so are strangers: revoking the last device never reopens the gate
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
  });

  it("revokes every device in one answer that clears the caller's own cookie, and takes revoke-all for no device id", async () => {
    const pair = async (label: string) => {
      const { code } = (await (await fetch(`${base()}/api/devices/pair/start`, { method: "POST", headers: guard })).json()) as { code: string };
      const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code, label }) });
      expect(paired.status).toBe(204);
      return paired.headers.get("set-cookie")!.split(";")[0]!;
    };
    const phone = await pair("Phone");
    const tablet = await pair("Tablet");
    expect(await auth({ ...proxied(), cookie: tablet })).toMatchObject({ authenticated: true, via: "device" });
    // the route comes before the device ids: another method on it is refused as a method, never read as a device
    const asDevice = await fetch(`${base()}/api/devices/revoke-all`, { method: "DELETE", headers: guard });
    expect([asDevice.status, ((await asDevice.json()) as ApiError).error.code]).toEqual([400, "method_not_allowed"]);
    expect((await fetch(`${base()}/api/devices/revoke-all`, { method: "POST" })).status).toBe(403); // the mutation guard
    // from a paired device: everything paired goes, that device's own pairing included, and its cookie with the answer
    const revoked = await fetch(`${base()}/api/devices/revoke-all`, { method: "POST", headers: { ...guard, ...proxied(), cookie: tablet } });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("content-type")).toContain("application/json");
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(await revoked.json()).toEqual({ revoked: 2 });
    expect(revoked.headers.getSetCookie()).toEqual([DEVICE_COOKIE_CLEARED, CLEAR_LEGACY_DEVICE_COOKIE]);
    for (const cookie of [phone, tablet]) expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(((await (await fetch(`${base()}/api/devices`)).json()) as { devices: unknown[] }).devices).toEqual([]);
    // the gate stays shut to strangers; this PC and the PC's Tailscale login are in as before
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    // with nothing left to revoke the answer is the same shape, and still a durable write
    const again = await fetch(`${base()}/api/devices/revoke-all`, { method: "POST", headers: guard });
    expect([again.status, await again.json()]).toEqual([200, { revoked: 0 }]);
    expect(JSON.parse(readFileSync(join(openState, "devices.json"), "utf8"))).toEqual({ gate_closed_at: expect.any(String), devices: [] });
  });

  it("the plugin script prints a code a headless PC's owner can hand to a phone", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "herdr-pair-cli-"));
    try {
      // spawned asynchronously: a synchronous spawn would block the very server the script asks
      const pairCli = async (port: number) => {
        const child = Bun.spawn(["bun", "scripts/plugin.ts", "pair"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
        const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { out, err, exitCode };
      };
      const run = await pairCli(open.port);
      const out = run.out;
      expect(run.exitCode, run.err).toBe(0);
      const code = /Pairing code: (\d{3}) (\d{3})/.exec(out);
      expect(code).not.toBeNull();
      expect(out).toContain("enter the code");
      const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: `${code![1]}${code![2]}`, label: "Phone by CLI" }) });
      expect(paired.status).toBe(204);
      const list = (await (await fetch(`${base()}/api/devices`)).json()) as { devices: Array<{ label: string }> };
      expect(list.devices.map((d) => d.label)).toContain("Phone by CLI");
      // with a token configured, the script reads it from the plugin's .env file and gets past the gate
      const tokenState = mkdtempSync(join(tmpdir(), "herdr-pair-cli-token-"));
      const secured = createServer({ port: 0, stateDir: tokenState, token: "cli-t0k3n", tailscaleOwner: null });
      try {
        writeFileSync(join(configDir, ".env"), "OVIS_TOKEN=cli-t0k3n\n");
        const withToken = await pairCli(secured.port);
        expect(withToken.exitCode, withToken.err).toBe(0);
        expect(withToken.out).toMatch(/Pairing code: \d{3} \d{3}/);
        // `.env` wins over a stale token in the older `env` file
        writeFileSync(join(configDir, "env"), "OVIS_TOKEN=stale\n");
        const withLegacy = await pairCli(secured.port);
        expect(withLegacy.exitCode, withLegacy.err).toBe(0);
        expect(withLegacy.out).toMatch(/Pairing code: \d{3} \d{3}/);
      } finally { secured.stop(); rmSync(tokenState, { recursive: true, force: true }); }
    } finally { rmSync(configDir, { recursive: true, force: true }); }
  });

  it("a configured token gates this PC and its Tailscale login, and a paired device gets past it", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-pairing-token-"));
    const secured = createServer({ port: 0, stateDir: state, token: "t0k3n", tailscaleOwner: OWNER });
    const at = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${secured.port}/api/health?scope=bridge`, { headers }).then((r) => r.json() as Promise<{ auth: HealthAuth }>).then((b) => b.auth);
    try {
      expect(await at()).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ authorization: "Bearer wrong" })).toEqual({ required: true, authenticated: false, reason: "token_required" });
      expect(await at({ authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token", bearer: true });
      // a token held in the sign-in cookie is one signing out can clear
      expect(await at({ cookie: "ovis_token=t0k3n" })).toEqual({ required: false, authenticated: true, via: "token", role: "drive" });
      expect(await at({ cookie: "ovis_token=t0k3n", authorization: "Bearer wrong" })).toEqual({ required: false, authenticated: true, via: "token", role: "drive" });
      // another proxy on this PC can pass a visitor's copy of the login header on: the token is asked for anyway
      expect(await at(proxied(OWNER))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ ...proxied(OWNER), authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token" });
      // health only reports the decision: the guarded routes and the upgrade must refuse the header too
      expect((await fetch(`http://127.0.0.1:${secured.port}/api/session`, { headers: proxied(OWNER) })).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${secured.port}/ws`, { headers: proxied(OWNER) })).status).toBe(401);
      // a pairing started with the token lets a device in without it
      const started = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair/start`, { method: "POST", headers: { ...guard, authorization: "Bearer t0k3n" } });
      const { code } = (await started.json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
      expect(paired.status).toBe(204);
      expect(await at({ cookie: (paired.headers.get("set-cookie") ?? "").split(";")[0]! })).toMatchObject({ authenticated: true, via: "device" });
    } finally { secured.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("token auth", () => {
  /**
   * A second server with the gate ON: the default instance above stays open so the
   * rest of the suite keeps proving that an empty token changes nothing.
   */
  const TOKEN = "s3cret";
  let secured: { port: number; stop: () => void };

  beforeAll(() => {
    secured = createServer({ port: 0, token: TOKEN, stateDir });
  });

  afterAll(() => {
    secured?.stop();
  });

  const securedBase = () => `http://127.0.0.1:${secured.port}`;
  const wsUrl = () => `ws://127.0.0.1:${secured.port}/ws`;

  it("rejects an unauthenticated API call with 401 unauthorized", async () => {
    const res = await fetch(`${securedBase()}/api/session`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps web push behind the gate: a subscription receives pane titles", async () => {
    for (const [method, path] of [["GET", "/api/push"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/test"]] as const) {
      const res = await fetch(`${securedBase()}${path}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("keeps the image upload behind the gate", async () => {
    const res = await fetch(`${securedBase()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "w1:p1", content_type: "image/png", data_base64: "aaaa" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps /api/health public and advertises the gate state", async () => {
    const res = await fetch(`${securedBase()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: HealthAuth; herdr: { version: string; protocol: number; terminal_attach?: boolean } };
    expect(body.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    // a Unix herdr attaches terminals; Windows PCs report false and open in the chat lens
    expect(body.herdr.terminal_attach).toBe(true);
  });

  it("tells a client that got in when this server is open to the network, and nobody else", async () => {
    // the health body is JSON off the wire; LanExposure is the shape this endpoint adds to it
    type HealthBody = { auth: HealthAuth; lan_exposure?: LanExposure };
    const health = async (port: number, headers: Record<string, string> = {}): Promise<HealthBody> =>
      (await (await fetch(`http://127.0.0.1:${port}/api/health`, { headers })).json()) as HealthBody;
    // no token and nothing paired, pinned so an inherited OVIS_TOKEN cannot gate the case
    const bound = (hostname: string) => {
      const stateDir = mkdtempSync(join(tmpdir(), "herdr-lan-"));
      const instance = createServer({ port: 0, hostname, token: "", stateDir });
      return { port: instance.port, stop: () => { instance.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
    };
    const open = bound("0.0.0.0");
    try {
      // bound past this PC, no token, nothing paired: the one state the warning is for
      expect((await health(open.port)).lan_exposure).toEqual({ host: "0.0.0.0" });
      // a request that did not get in is told nothing, whatever the server's state: Funnel is the
      // public internet, which is never "open" (server/access.ts)
      const refused = await health(open.port, { "x-forwarded-for": "100.64.0.9", "tailscale-funnel-request": "?1" });
      expect(refused.auth).toMatchObject({ required: true, authenticated: false, reason: "pairing_required" });
      expect(refused.lan_exposure).toBeUndefined();
      // pairing one device closes the gate to strangers, and the warning leaves with the state
      const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
      const { code } = (await (await fetch(`http://127.0.0.1:${open.port}/api/devices/pair/start`, { method: "POST", headers: guard })).json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${open.port}/api/devices/pair`, { method: "POST", headers: { ...guard, "x-forwarded-for": "100.64.0.9" }, body: JSON.stringify({ code, label: "Phone" }) });
      expect(paired.status).toBe(204);
      expect((await health(open.port)).lan_exposure).toEqual({ host: "0.0.0.0" });
      const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
      expect((await health(open.port, { cookie })).auth).toMatchObject({ authenticated: true, via: "device" });
      expect((await health(open.port)).auth).toMatchObject({ authenticated: true, via: "local" });
      expect((await health(open.port)).lan_exposure).toBeUndefined();
    } finally {
      open.stop();
    }
    // the same empty configuration on a loopback bind is unreachable from the network
    const loopback = bound("127.0.0.1");
    try {
      expect((await health(loopback.port)).lan_exposure).toBeUndefined();
    } finally {
      loopback.stop();
    }
    // and a token is a closed gate, which this endpoint already reported
    const securedBody = await (await fetch(`${securedBase()}/api/health`)).json() as HealthBody;
    expect(securedBody.lan_exposure).toBeUndefined();
  });

  it("refuses a token that does not match", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("invalid_token");
  });

  it("hands back a hardened session cookie for the right token", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`ovis_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=31536000");
  });

  it("accepts the session cookie", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { cookie: `ovis_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("expires the cookie on logout", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("never upgrades a websocket without a token", async () => {
    const ws = new WebSocket(wsUrl());
    const outcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error/close within 5000ms")), 5000);
      const settle = (result: string) => {
        clearTimeout(timer);
        resolve(result);
      };
      ws.addEventListener("error", () => settle("error"));
      ws.addEventListener("close", () => settle("close"));
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("the upgrade succeeded without a token"));
      });
    });
    expect(["error", "close"]).toContain(outcome);
  }, 10000);

  it("upgrades a websocket that carries the cookie", async () => {
    const ws = connectWithCookie(wsUrl(), `ovis_token=${TOKEN}`);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 5000ms")), 5000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the upgrade was refused despite a valid cookie"));
      });
      // a status of some pane may be broadcast before this connection's own snapshot is read
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type: string };
        if (message.type !== "snapshot") return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    expect(first.type).toBe("snapshot");
    ws.close();
  }, 10000);
});

describe("bind address", () => {
  let loopback: { port: number; stop: () => void };

  beforeAll(() => {
    loopback = createServer({ port: 0, hostname: "127.0.0.1", stateDir });
  });

  afterAll(() => {
    loopback?.stop();
  });

  it("serves the API on the requested hostname", async () => {
    const res = await fetch(`http://127.0.0.1:${loopback.port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("generated wire types", () => {
  it("carries an unknown agent_status through instead of dropping or throwing", async () => {
    // herdr gives no stability guarantee: a status this build has never heard of
    // must still reach the UI so it can render something honest.
    const res = await fetch(`${base()}/api/session`);
    const { snapshot } = (await res.json()) as { snapshot: SessionSnapshot };
    const mutated: SessionSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        agent_status: "teleporting" as AgentStatus,
      })),
    };
    const roundTripped = JSON.parse(JSON.stringify(mutated)) as SessionSnapshot;
    for (const workspace of roundTripped.workspaces) {
      expect(workspace.agent_status).toBe("teleporting");
    }
    expect(roundTripped.workspaces.length).toBe(snapshot.workspaces.length);
  });
});


describe("PC management API", () => {
  it("reports bridge auth independently of herdr and exposes the local PC", async () => {
    const health = await fetch(`${base()}/api/health?scope=bridge`);
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: HealthAuth; bridge_protocol: number };
    expect(body.bridge_protocol).toBe(1);
    expect(body.auth.authenticated).toBe(true);
    const list = await fetch(`${base()}/api/machines`);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const data = await list.json() as { machines: { id: string; kind: string }[] };
    expect(data.machines[0]).toMatchObject({ id: "local", kind: "local" });
    const local = await fetch(`${base()}/api/machines/local/session`);
    expect(local.status).toBe(200);
    const viaAlias = await fetch(`${base()}/api/machines/local/integrations`);
    expect(viaAlias.status).toBe(200);
    const direct = await fetch(`${base()}/api/integrations`);
    expect(await viaAlias.json()).toEqual(await direct.json());
  });
  it("rejects CSRF, malformed targets and remote forwarding outside the allowlist", async () => {
    for (const headers of [{}, { "x-herdr-machine": "1", origin: "https://evil.invalid" }, { "x-herdr-machine": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers, body: JSON.stringify({ destination: "host" }) });
      expect(response.status).toBe(403);
    }
    const bad = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: JSON.stringify({ destination: "-oProxyCommand=bad" }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base()}/api/machines/missing/pane/read?pane_id=p1`)).status).toBe(503);
    expect((await fetch(`${base()}/api/machines/missing/auth`)).status).toBe(404);
  });
  it("answers another PC's oversized or unreadable answer with a safe 502", async () => {
    const secret = "fixture-contract-secret";
    let serve = () => new Response("{}");
    const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => serve() });
    const url = `http://127.0.0.1:${peer.port}`;
    const retried: string[] = [];
    const manager = { endpoint: (id: string) => id === "capped-remote" ? { url, token: "contract-token" } : undefined, trackTerminal: () => () => {}, retryNow: (id: string) => { retried.push(id); } } as unknown as MachineManager;
    const ask = (machine: string, path: string, readOnly = false) => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${machine}/${path}`), manager, undefined, undefined, readOnly);
    const logged: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    try {
      // a watcher's prompt is parsed to remove what it may not see, so it is held to 1 MiB
      serve = () => new Response(`{"prompt":null,"restored":"${secret}${"x".repeat(1024 * 1024)}"}`);
      const large = await ask("capped-remote", "pane/prompt?pane_id=p1", true);
      expect(large.status).toBe(502);
      const tooLarge = await large.json() as ApiError;
      expect(tooLarge.error.code).toBe("remote_response_too_large");
      serve = () => new Response(`{"prompt":{"plan_file":"${secret}"`);
      const unreadable = await ask("capped-remote", "pane/prompt?pane_id=p1", true);
      expect(unreadable.status).toBe(502);
      const invalid = await unreadable.json() as ApiError;
      expect(invalid.error.code).toBe("remote_response_invalid");
      for (const text of [JSON.stringify(tooLarge), JSON.stringify(invalid), logged.join("\n")]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(url);
        expect(text).not.toContain("contract-token");
      }
      // a disconnected PC is refused before any request leaves for it
      const offline = await ask("missing", "session");
      expect(offline.status).toBe(503);
      expect((await offline.json() as ApiError).error.code).toBe("machine_offline");
      // and asked to try connecting now rather than after its retry delay
      expect(retried).toEqual(["missing"]);
    } finally { error.mockRestore(); peer.stop(true); }
  });
  it("gates PC metadata, setup and SSE behind the existing token", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-machine-auth-"));
    const gated = createServer({ port: 0, token: "machine-test-secret", stateDir });
    try {
      for (const path of ["/api/machines", "/api/machines/events", "/api/machines/setup", "/api/bridge"]) expect((await fetch(`http://localhost:${gated.port}${path}`)).status).toBe(401);
      const health = await fetch(`http://localhost:${gated.port}/api/health?scope=bridge`).then((r) => r.json()) as { auth: HealthAuth };
      expect(health.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    } finally { gated.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe("terminal lens of a bridge without the PTY sidecar", () => {
  const TOKEN = "sidecar-test-secret";
  /** what /api/health and /api/bridge tell of herdr, from a bridge whose runtime has the sidecar or lacks it */
  const told = async (sidecar: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-sidecar-"));
    const bridge = createServer({ port: 0, stateDir: dir, token: TOKEN, machines: false, sidecar });
    try {
      const get = async (path: string) => {
        const response = await fetch(`http://localhost:${bridge.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(200);
        return (await response.json()) as { herdr: unknown };
      };
      return { health: (await get("/api/health")).herdr, bridge: (await get("/api/bridge")).herdr };
    } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
  };

  it("reports a mirror from /api/health and /api/bridge though herdr itself can attach", async () => {
    const herdr = await ping();
    // the case only means something against a herdr that can attach
    expect(herdr.terminal_attach).toBe(true);
    const mirrored = { ...herdr, terminal_attach: false, terminal_mirror: true };
    expect(await told(false)).toEqual({ health: mirrored, bridge: mirrored });
  });

  it("passes herdr's own answer through where the sidecar runs", async () => {
    const herdr = await ping();
    expect(herdr).not.toHaveProperty("terminal_mirror");
    expect(await told(true)).toEqual({ health: herdr, bridge: herdr });
  });
});

it("refuses cross-origin changes while allowing same-origin and CLI requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-origin-"));
  const instance = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${instance.port}`;
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-origin" });
  try {
    for (const path of ["pane/input", "pane/keys", "pane/close", "pane/focus", "layout/ratio", "workspace/create", "tab/create", "tab/rename", "tab/close", "tab/move", "push/subscribe"]) {
      const response = await fetch(`${base}/api/${path}`, { method: "POST", headers: { origin: "http://other.example", "content-type": "text/plain" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, text: "must not type", keys: ["Enter"] }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    }
    for (const headers of [{ origin: base }, {}] as Record<string, string>[]) {
      const response = await fetch(`${base}/api/pane/rename`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, label: "allowed rename" }) });
      expect(response.status).toBe(200);
    }
  } finally { instance.stop(); await workspaceClose(created.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
});

describe("repository diff of a pane's folder", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-test-repo-diff-")));
  let workspaceId: string | null = null;
  afterAll(async () => {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the repository the pane sits in, a folder named from it, and a named folder once the pane is gone", async () => {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    };
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "two\n");
    // the pane sits below the repository's top, and in no repository of its own
    const created = await workspaceCreate({ cwd: join(root, "sub"), label: "ovis-test-repo-diff" });
    workspaceId = created.workspace.workspace_id;
    const pane = `pane_id=${encodeURIComponent(created.root_pane.pane_id)}`;
    const expected: RepoDiffFileList["files"] = [{ path: "a.txt", old_path: null, status: "modified", additions: 1, deletions: 1, binary: false }];
    for (const url of [
      `${base()}/api/workspace/diff/files?${pane}`,
      `${base()}/api/machines/local/workspace/diff/files?${pane}`,
      `${base()}/api/workspace/diff/files?${pane}&directory=..`,
      `${base()}/api/workspace/diff/files?pane_id=no-such-pane&directory=${encodeURIComponent(root)}`,
    ]) {
      const response = await fetch(url);
      expect([url, response.status]).toEqual([url, 200]);
      const list = (await response.json()) as RepoDiffFileList;
      expect(list.repository).toMatchObject({ root, branch: "main", detached: false, unborn: false });
      expect(list.files).toEqual(expected);
    }
    const file = await fetch(`${base()}/api/workspace/diff/file?${pane}&path=a.txt`);
    expect(file.status).toBe(200);
    const answer = (await file.json()) as RepoDiffFilePatch;
    expect(answer).toMatchObject({ file: expected[0], unavailable: null, truncated: false });
    expect(answer.patch).toStartWith("diff --git a/a.txt b/a.txt\n");
    expect(answer.patch).toEndWith("-one\n+two\n");

    const gone = await fetch(`${base()}/api/workspace/diff/files?pane_id=no-such-pane`);
    expect(gone.status).toBe(404);
    expect(typeof ((await gone.json()) as ApiError).error.code).toBe("string");
    const relative = await fetch(`${base()}/api/workspace/diff/files?pane_id=no-such-pane&directory=sub`);
    expect(relative.status).toBe(400);
    expect(((await relative.json()) as ApiError).error.code).toBe("invalid_cwd");
    const posted = await fetch(`${base()}/api/workspace/diff/files?${pane}`, { method: "POST", headers: { "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect(((await posted.json()) as ApiError).error.code).toBe("method_not_allowed");

    // the branch against a base: the refs for the picker, the list from the merge base, each patch from the list's identity
    git("add", ".");
    git("commit", "-q", "-m", "on main");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "b.txt"), "branch\n");
    git("add", ".");
    git("commit", "-q", "-m", "branch work");
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(root, "untracked.txt"), "new\n");
    const mainOid = Bun.spawnSync(["git", "-C", root, "rev-parse", "main"], { stdout: "pipe" }).stdout.toString().trim();
    const headOid = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
    for (const prefix of ["", "machines/local/"]) {
      const refs = await fetch(`${base()}/api/${prefix}workspace/diff/refs?${pane}`);
      expect([prefix, refs.status]).toEqual([prefix, 200]);
      const listed = (await refs.json()) as RepoDiffRefs;
      expect(listed.refs).toEqual([{ name: "refs/heads/feature", oid: headOid }, { name: "refs/heads/main", oid: mainOid }, { name: "refs/remotes/origin/main", oid: mainOid }]);
      expect(listed).toMatchObject({ truncated: false, limits: { max_refs: 200 } });
      const branch = await fetch(`${base()}/api/${prefix}workspace/diff/files?${pane}&scope=branch&base=refs%2Fremotes%2Forigin%2Fmain`);
      expect([prefix, branch.status]).toEqual([prefix, 200]);
      const compared = (await branch.json()) as RepoDiffFileList;
      expect(compared).toMatchObject({ scope: "branch", base: mainOid, head: headOid, comparison: { repository_root: root, head_oid: headOid, base_oid: mainOid, merge_base_oid: mainOid } });
      expect(compared.files.map((file) => [file.path, file.status])).toEqual([["b.txt", "added"], ["untracked.txt", "untracked"]]);
      const comparison = encodeURIComponent(JSON.stringify(compared.comparison));
      const patch = await fetch(`${base()}/api/${prefix}workspace/diff/file?${pane}&scope=branch&path=untracked.txt&comparison=${comparison}`);
      expect([prefix, patch.status]).toEqual([prefix, 200]);
      const read = (await patch.json()) as RepoDiffFilePatch;
      expect(read).toMatchObject({ scope: "branch", comparison: compared.comparison, file: { path: "untracked.txt", status: "untracked", binary: false }, unavailable: null });
      expect(read.patch).toStartWith("diff --git a/untracked.txt b/untracked.txt\n");
      // a malformed identity, one of another HEAD, and a patch asked by the base's name instead of the identity
      for (const [search, status, code] of [
        [`scope=branch&path=b.txt&comparison=${encodeURIComponent("{\"head_oid\":1}")}`, 400, "invalid_comparison"],
        // a full git id is 40 or 64 hex digits: 41 is a malformed shape, not a moved HEAD or a missing commit
        ...(["head_oid", "base_oid", "merge_base_oid"] as const).map((key) => [`scope=branch&path=b.txt&comparison=${encodeURIComponent(JSON.stringify({ ...compared.comparison, [key]: "a".repeat(41) }))}`, 400, "invalid_comparison"] as const),
        [`scope=branch&path=b.txt&comparison=${encodeURIComponent(JSON.stringify({ ...compared.comparison, head_oid: "0".repeat(40) }))}`, 409, "comparison_changed"],
        ["scope=branch&path=b.txt&base=main", 400, "invalid_comparison"],
      ] as const) {
        const refused = await fetch(`${base()}/api/${prefix}workspace/diff/file?${pane}&${search}`);
        expect([prefix, search, refused.status]).toEqual([prefix, search, status]);
        expect(((await refused.json()) as ApiError).error.code).toBe(code);
      }
      // a base that names no commit, and one that shares no history
      const unknown = await fetch(`${base()}/api/${prefix}workspace/diff/files?${pane}&scope=branch&base=no-such-branch`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as ApiError).error.code).toBe("revision_not_found");
    }
    // another site's page reads none of it
    for (const route of ["refs", "files?scope=branch&base=main"]) {
      const crossSite = await fetch(`${base()}/api/workspace/diff/${route.includes("?") ? route.replace("?", `?${pane}&`) : `${route}?${pane}`}`, { headers: { "sec-fetch-site": "cross-site" } });
      expect([route, crossSite.status]).toEqual([route, 403]);
      expect(((await crossSite.json()) as ApiError).error.code).toBe("cross_site");
    }
  });
});

describe("GET /api/sessions/history", () => {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;

  /**
   * Own all setup and cleanup, including failures before a server or workspace is returned.
   * The server's state is kept out of `root`: stop() does not wait for a read of the panes that is still in
   * flight, and that read saves completions.json when it lands, which would bring back a `root` removed here.
   * It goes under this file's state folder, which afterAll removes.
   */
  async function withPiHistoryFixture(root: string, run: (fixture: { file: string; initial: string; url: string }) => Promise<void>, piSessionDeadlineMs?: number): Promise<void> {
    const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let app: ReturnType<typeof createServer> | undefined;
    try {
      const project = join(root, "project");
      mkdirSync(project);
      const cwd = realpathSync(project);
      const store = join(root, "sessions");
      const { piSessionFolder } = await import("./session-history.ts");
      const folder = join(store, piSessionFolder(cwd));
      mkdirSync(folder, { recursive: true });
      const file = join(folder, "fixture.jsonl");
      const initial = line({ type: "session", version: 3, id: "pi-history-fixture", cwd })
        + line({ type: "message", message: { role: "system", content: "s".repeat(100 * 1024) } })
        + line({ type: "message", message: { role: "user", content: [{ type: "text", text: "Late" }, { type: "text", text: "prompt" }] } })
        + line({ type: "session_info", name: " Late name " });
      writeFileSync(file, initial);
      process.env["PI_CODING_AGENT_SESSION_DIR"] = store;
      created = await workspaceCreate({ cwd, label: "ovis-test-pi-history" });
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(stateDir, basename(root)), piSessionDeadlineMs });
      const url = `http://127.0.0.1:${app.port}/api/sessions/history?workspace_id=${encodeURIComponent(created.workspace.workspace_id)}&agent=pi`;
      await run({ file, initial, url });
    } finally {
      try { app?.stop(); }
      finally {
        if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"]; else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
        try { if (created) await workspaceClose(created.workspace.workspace_id); }
        finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }

  it("streams Pi labels past the old head bound and follows appended renames/clears without changing resume IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-history-contract-"));
    await withPiHistoryFixture(root, async ({ file, initial, url }) => {
      const listing = async () => {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        return ((await response.json()) as SessionHistoryResponse).sessions;
      };
      expect(await listing()).toMatchObject([{ title: "Late name", firstMessage: "Late prompt", resume: { argv: ["pi", "--session", "pi-history-fixture"] } }]);
      writeFileSync(file, initial + line({ type: "session_info", name: "Renamed" }));
      expect((await listing())[0]?.title).toBe("Renamed");
      writeFileSync(file, initial + line({ type: "session_info", name: " " }));
      expect((await listing())[0]).toMatchObject({ title: null, firstMessage: "Late prompt" });
      // A fresh streaming read has no old 16 MiB per-turn cutoff.
      const block = line({ type: "message", message: { role: "system", content: "s".repeat(1024 * 1024) } });
      for (let n = 0; n < 17; n++) appendFileSync(file, block);
      appendFileSync(file, line({ type: "session_info", name: "After bounded scan" }));
      expect((await listing())[0]).toMatchObject({ title: "After bounded scan", firstMessage: "Late prompt" });
      // A full header queue still refuses the listing even after a real first row.
      const older = join(dirname(file), "older.jsonl");
      writeFileSync(older, initial.replace("pi-history-fixture", "pi-history-older"));
      utimesSync(older, 1, 1);
      const { PiSessionReader, PiMetadataBusy, PiMetadataDeadline } = await import("./pi-session-metadata.ts");
      const originalRead = PiSessionReader.prototype.read;
      let firstComplete = false;
      const refusedRead = spyOn(PiSessionReader.prototype, "read").mockImplementationOnce(function (this: InstanceType<typeof PiSessionReader>, ...args: Parameters<typeof originalRead>) {
        return originalRead.apply(this, args).then((label) => { firstComplete = label?.header?.id === "pi-history-fixture"; return label; });
      }).mockRejectedValueOnce(new PiMetadataBusy("queue"));
      try {
        const busy = await fetch(url);
        expect(firstComplete).toBe(true);
        expect(refusedRead).toHaveBeenCalledTimes(2);
        expect(busy.status).toBe(503);
        expect(busy.headers.get("retry-after")).toBe("1");
        expect(busy.headers.get("cache-control")).toBe("no-store");
        const body = await busy.json();
        expect(body).toMatchObject({ error: { code: "session_history_busy" } });
        expect(body).not.toHaveProperty("sessions");
      } finally { refusedRead.mockRestore(); }
      for (const failure of [new PiMetadataDeadline(null), new PiMetadataBusy()]) {
        const failedLabel = spyOn(PiSessionReader.prototype, "read").mockImplementation(function (this: InstanceType<typeof PiSessionReader>, ...args: Parameters<typeof originalRead>) {
          if (args[3] !== "header" && args[2]?.path === realpathSync(older)) return Promise.reject(failure);
          return originalRead.apply(this, args);
        });
        try {
          const partial = await fetch(url);
          expect(partial.status).toBe(200);
          expect(partial.headers.get("cache-control")).toBe("no-store");
          expect(partial.headers.get("retry-after")).toBeNull();
          expect(((await partial.json()) as SessionHistoryResponse).sessions).toMatchObject([
            { id: "pi-history-fixture", title: "After bounded scan" },
            { id: "pi-history-older", title: null, firstMessage: null, resume: { argv: ["pi", "--session", "pi-history-older"] } },
          ]);
        } finally { failedLabel.mockRestore(); }
      }
      expect((await listing())[1]).toMatchObject({ id: "pi-history-older", title: "Late name", firstMessage: "Late prompt" });
    }, 120_000);
  }, 20_000);

  it("lists a 202-session Pi store with 50 long transcripts through the real API", async () => {
    // the rows, titles and a later rename are the claim, not how fast this runner reads the store: a busy
    // CI runner hit the two-second listing deadline (503), so the deadline is set past the test's own timeout
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-large-history-contract-"));
    await withPiHistoryFixture(root, async ({ file, url }) => {
      const cwd = realpathSync(join(root, "project"));
      const block = line({ type: "custom", data: "synthetic extension state ".repeat(45000) });
      utimesSync(file, 1_790_000_000, 1_790_000_000);
      for (let n = 1; n < 202; n++) {
        const path = join(dirname(file), `${n}.jsonl`);
        const body = line({ type: "session", version: 3, id: `long-${n}`, cwd })
          + (n < 152 ? "" : block + line({ type: "message", message: { role: "user", content: `Synthetic prompt ${n}` } })
            + line({ type: "session_info", name: `Synthetic session ${n}` }) + block.repeat(3));
        writeFileSync(path, body);
        utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
      }
      const listing = async () => {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        return ((await response.json()) as SessionHistoryResponse).sessions;
      };
      const rows = await listing();
      expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, n) => `long-${201 - n}`));
      expect(rows.every((row, n) => row.title === `Synthetic session ${201 - n}` && row.firstMessage === `Synthetic prompt ${201 - n}`)).toBe(true);
      // Reopening must scan again and notice a later name, not reuse the completed answer.
      const renamed = join(dirname(file), "201.jsonl");
      appendFileSync(renamed, line({ type: "session_info", name: "Freshly renamed" }));
      utimesSync(renamed, 1_790_000_202, 1_790_000_202);
      expect((await listing())[0]).toMatchObject({ id: "long-201", title: "Freshly renamed", resume: { argv: ["pi", "--session", "long-201"] } });
    }, 120_000);
  }, 60_000);

  for (const phase of ["workspace creation", "server creation", "server stop", "workspace close"] as const) {
    it(`cleans up the Pi history fixture when ${phase} fails`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ovis-pi-history-failure-"));
      const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
      const failure = new Error(`synthetic ${phase} failure`);
      const createWorkspace = herdrClient.workspaceCreate;
      const createApp = appModule.createServer;
      const closeWorkspace = herdrClient.workspaceClose;
      const restores: Array<() => void> = [];
      let workspaceId: string | undefined;
      let stop: (() => void) | undefined;
      let stopped = false;
      let closed = false;
      try {
        const creating = spyOn(herdrClient, "workspaceCreate").mockImplementation(async (...args) => {
          if (phase === "workspace creation") throw failure;
          const created = await createWorkspace(...args);
          workspaceId = created.workspace.workspace_id;
          return created;
        });
        restores.push(() => creating.mockRestore());
        const starting = spyOn(appModule, "createServer").mockImplementation((...args) => {
          if (phase === "server creation") throw failure;
          const app = createApp(...args);
          stop = app.stop;
          const stopping = spyOn(app, "stop").mockImplementation(() => {
            stop!();
            stopped = true;
            if (phase === "server stop") throw failure;
          });
          restores.push(() => stopping.mockRestore());
          return app;
        });
        restores.push(() => starting.mockRestore());
        const closing = spyOn(herdrClient, "workspaceClose").mockImplementation(async (...args) => {
          if (phase === "workspace close") throw failure;
          await closeWorkspace(...args);
          closed = true;
        });
        restores.push(() => closing.mockRestore());

        await expect(withPiHistoryFixture(root, async () => {})).rejects.toBe(failure);
        expect(process.env["PI_CODING_AGENT_SESSION_DIR"]).toBe(previous);
        expect(existsSync(root)).toBe(false);
        expect(starting).toHaveBeenCalledTimes(phase === "workspace creation" ? 0 : 1);
        if (stop) expect(stopped).toBe(true);
        if (workspaceId) {
          expect(closing).toHaveBeenCalledWith(workspaceId);
          expect(closed).toBe(phase !== "workspace close");
          expect((await sessionSnapshot()).workspaces.some((workspace) => workspace.workspace_id === workspaceId)).toBe(phase === "workspace close");
        }
      } finally {
        for (const restore of restores.reverse()) restore();
        // The injected close failure deliberately leaves our own isolated workspace alive;
        // recover it here even if a cleanup assertion above failed.
        try { if (stop && !stopped) stop(); }
        finally {
          try { if (workspaceId && !closed) await closeWorkspace(workspaceId); }
          finally {
            if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"]; else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    }, 20_000);
  }

  it("lists a workspace folder's Codex sessions from the server's store, newest first, and none a link puts outside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-session-history-contract-"));
    const project = join(root, "project");
    mkdirSync(project);
    const cwd = realpathSync(project);
    const codexHome = join(root, "codex");
    const rollout = (day: string, id: string, prompt: string) => {
      const dir = join(codexHome, "sessions", "2026", "10", day);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-10-${day}T09-00-00-${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id, timestamp: `2026-10-${day}T09:00:00.000Z`, cwd, source: "cli" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: prompt } })}\n`);
      return path;
    };
    const older = "00000000-0000-4000-8000-000000000001";
    const newer = "00000000-0000-4000-8000-000000000002";
    utimesSync(rollout("01", older, "older prompt"), 1_790_000_000, 1_790_000_000);
    utimesSync(rollout("02", newer, "newer prompt"), 1_790_000_100, 1_790_000_100);
    const escaped = "00000000-0000-4000-8000-000000000009";
    const outside = join(root, `rollout-2026-10-03T09-00-00-${escaped}.jsonl`);
    writeFileSync(outside, `${JSON.stringify({ type: "session_meta", payload: { id: escaped, cwd, source: "cli" } })}\n`);
    if (process.platform !== "win32") symlinkSync(outside, join(codexHome, "sessions", "2026", "10", "02", basename(outside)));
    const created = await workspaceCreate({ cwd, label: "ovis-test-session-history" });
    const appState = mkdtempSync(join(tmpdir(), "ovis-session-history-state-"));
    const app = createServer({ port: 0, stateDir: appState, codexHome });
    try {
      const res = await fetch(`http://localhost:${app.port}/api/sessions/history?workspace_id=${encodeURIComponent(created.workspace.workspace_id)}&agent=codex`);
      expect(res.status).toBe(200);
      const body = await res.json() as SessionHistoryResponse;
      expect(body.cwd).toBe(cwd);
      expect(body.sessions.map((row) => [row.id, row.firstMessage, row.resume?.argv])).toEqual([
        [newer, "newer prompt", ["codex", "resume", newer]],
        [older, "older prompt", ["codex", "resume", older]],
      ]);
      const unknown = await fetch(`http://localhost:${app.port}/api/sessions/history?workspace_id=${encodeURIComponent(created.workspace.workspace_id)}&agent=bash`);
      expect(unknown.status).toBe(400);
      // another PC asks with the bridge token this server registered, not a browser's: the proxy's way in
      const bridgeState = mkdtempSync(join(tmpdir(), "ovis-session-history-bridge-"));
      const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: bridgeState, codexHome, tailscaleOwner: null });
      try {
        const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
        const manager = { endpoint: (id: string) => id === "history-remote" ? { url: `http://127.0.0.1:${bridge.port}`, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
        const remote = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/history-remote/sessions/history?workspace_id=${encodeURIComponent(created.workspace.workspace_id)}&agent=codex`), manager);
        expect(remote.status).toBe(200);
        expect(((await remote.json()) as SessionHistoryResponse).sessions.map((row) => row.id)).toEqual([newer, older]);
      } finally {
        bridge.stop();
        rmSync(bridgeState, { recursive: true, force: true });
      }
    } finally {
      app.stop();
      await workspaceClose(created.workspace.workspace_id);
      rmSync(appState, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("workspace order evidence", () => {
  /** the first SSE roster whose local snapshot `check` accepts */
  async function machinesEvent(origin: string, check: (snapshot: SessionSnapshot) => boolean): Promise<SessionSnapshot> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await fetch(`${origin}/api/machines/events`, { signal: abort.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended");
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
          if (!data) continue;
          const event = JSON.parse(data) as { type: string; machines?: { id: string; snapshot: SessionSnapshot | null }[] };
          const local = event.type === "machines" ? event.machines?.find((machine) => machine.id === "local")?.snapshot : null;
          if (local && check(local)) return local;
        }
      }
    } finally { clearTimeout(timer); abort.abort(); }
  }

  it("health, session, websocket and move answers share one order per server lifetime", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-order-"));
    const state = join(root, "state");
    const first = await workspaceCreate({ cwd: root, label: "ovis-test-order-first" });
    const second = await workspaceCreate({ cwd: root, label: "ovis-test-order-second" });
    const managedBoot = process.env["OVIS_BOOT_ID"];
    delete process.env["OVIS_BOOT_ID"];
    let app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state });
    try {
      let origin = `http://127.0.0.1:${app.port}`;
      const health = async () => ((await (await fetch(`${origin}/api/health`)).json()) as { web_ui: { boot_id: string } }).web_ui.boot_id;
      const session = async () => ((await (await fetch(`${origin}/api/session`)).json()) as { snapshot: SessionSnapshot }).snapshot;
      const move = async (workspaceId: string) => {
        const response = await fetch(`${origin}/api/workspace/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: workspaceId, insert_index: 0 }) });
        expect(response.status).toBe(200);
        return response.json();
      };
      const boot = await health();
      expect(boot).toEqual(expect.any(String));
      // reads never count: two GETs, then the opening websocket snapshot, all at 0
      expect(await session()).toMatchObject({ order_epoch: boot, read_seq: 0 });
      expect(await session()).toMatchObject({ order_epoch: boot, read_seq: 0 });
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      const opening = await new Promise<SessionSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no opening snapshot")), 10_000);
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; snapshot?: SessionSnapshot };
          if (message.type === "snapshot") { clearTimeout(timer); resolve(message.snapshot!); }
        });
      });
      ws.close();
      expect(opening).toMatchObject({ order_epoch: boot, read_seq: 0 });
      expect(await move(second.workspace.workspace_id)).toEqual({ ok: true, order_epoch: boot, moved_seq: 1 });
      expect(await session()).toMatchObject({ order_epoch: boot, read_seq: 1 });
      const roster = machinesEvent(origin, (snapshot) => (snapshot.read_seq ?? 0) >= 2);
      expect(await move(first.workspace.workspace_id)).toEqual({ ok: true, order_epoch: boot, moved_seq: 2 });
      // the move's own roster read follows it: the manager's copy carries the source's pair as read
      expect(await roster).toMatchObject({ order_epoch: boot, read_seq: 2 });
      const machines = (await (await fetch(`${origin}/api/machines`)).json()) as { machines: { id: string; source_boot_id?: string }[]; verified_source_boot?: unknown };
      expect(machines.machines[0]).toMatchObject({ id: "local", source_boot_id: boot });
      expect(machines.verified_source_boot).toBeUndefined();
      const verified = await fetch(`${origin}/api/machines?verify_source_boot=local`);
      expect(verified.status).toBe(200);
      expect(((await verified.json()) as { verified_source_boot: unknown }).verified_source_boot).toEqual({ machine_id: "local", boot_id: boot });
      expect((await fetch(`${origin}/api/machines?verify_source_boot=`)).status).toBe(400);
      expect((await fetch(`${origin}/api/machines?verify_source_boot=nobody`)).status).toBe(404);
      // a restart is a new epoch, counted again from 0, and health says the same boot
      app.stop();
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state });
      origin = `http://127.0.0.1:${app.port}`;
      const restarted = await health();
      expect(restarted).not.toBe(boot);
      expect(await session()).toMatchObject({ order_epoch: restarted, read_seq: 0 });
      expect(await move(second.workspace.workspace_id)).toEqual({ ok: true, order_epoch: restarted, moved_seq: 1 });
    } finally {
      app.stop();
      if (managedBoot === undefined) delete process.env["OVIS_BOOT_ID"]; else process.env["OVIS_BOOT_ID"] = managedBoot;
      await workspaceClose(first.workspace.workspace_id).catch(() => {});
      await workspaceClose(second.workspace.workspace_id).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});


/**
 * POST /api/sessions/resume end to end: herdr's real tab.create and agent.start, which types
 * `claude --resume <id>` into the new tab's shell. The `claude` that shell finds is a native stand-in
 * (a copy of Node renamed `claude`) that reports, over a loopback socket, whether CLAUDE_CONFIG_DIR
 * reached it and with what value, and appends to the transcript of the session in the store it
 * inherited; no real Claude runs. The stand-in has to come first on the PATH of herdr's own shells,
 * so this runs on a herdr session of its own, as reattach.contract.test.ts does, under a HOME of
 * its own: the default store (~/.claude) is the test's, never the user's.
 */
describe("POST /api/sessions/resume", () => {
  const NATIVE = process.platform === "linux" && Bun.which("node") !== null && process.env["HERDR_TEST_MODE"] !== "unit";
  const SESSION = "resume";
  // made in beforeAll, so a run whose filter leaves these tests out leaves no directory behind
  let config = "";
  let root = "";
  let home = "";
  let alternate = "";
  let project = "";
  let socket = "";
  const herdr = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr") || "herdr";
  const ID = "00000000-0000-4000-8000-0000000000c1";
  const OTHER = "00000000-0000-4000-8000-0000000000c2";
  const WATCH_TOKEN = "f".repeat(64);
  type Report = { pid: number; resumed: string | null; has: boolean; value: string | null };
  const queued: Report[] = [];
  const waiting: ((report: Report) => void)[] = [];
  let listener: { port: number; stop: (closeActive?: boolean) => void } | undefined;
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let app: ReturnType<typeof createServer> | undefined;
  let cwd = "";
  let workspaceId = "";
  let foreignWorkspace = "";
  const saved = { HERDR_SOCKET: process.env["HERDR_SOCKET"], HOME: process.env["HOME"], CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"], PATH: process.env["PATH"] };
  const restore = (name: keyof typeof saved) => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; };
  const rpc = <T,>(method: string, params: Record<string, unknown>) => herdrRpc<T>(method, params, socket);
  const snapshotNow = async () => (await rpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
  const tabsOf = async (workspace: string) => (await snapshotNow()).tabs.filter((tab) => tab.workspace_id === workspace).length;
  /** the next stand-in's report, in the order they started; bounded */
  const nextReport = (): Promise<Report> => {
    const ready = queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no Claude stand-in reported within 20 s")), 20_000);
      waiting.push((report) => { clearTimeout(timer); resolve(report); });
    });
  };
  const transcript = (store: string, id: string) => join(store, "projects", claudeProjectDir(cwd), `${id}.jsonl`);
  const writeSession = (store: string, id: string, prompt: string) => {
    mkdirSync(join(transcript(store, id), ".."), { recursive: true });
    writeFileSync(transcript(store, id), `${JSON.stringify({ type: "user", cwd, sessionId: id, timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: prompt } })}\n`);
  };
  /** A tab of the workspace running a stand-in Claude with `store` exported (null: none exported); the tab's own env, if given, is its shell's. */
  const sourcePane = async (store: string | null, tabEnv?: Record<string, string>, command = "claude") => {
    const tab = await rpc<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, cwd, focus: false, ...(tabEnv ? { env: tabEnv } : {}) });
    const pane = tab.root_pane.pane_id;
    await rpc("pane.send_text", { pane_id: pane, text: `${store === null ? "env -u CLAUDE_CONFIG_DIR" : `env CLAUDE_CONFIG_DIR='${store}'`} ${command}\n` });
    return { pane, report: await nextReport() };
  };
  const list = async (pane: string) => {
    const response = await fetch(`http://127.0.0.1:${app!.port}/api/sessions/history?workspace_id=${encodeURIComponent(workspaceId)}&agent=claude&pane_id=${encodeURIComponent(pane)}`);
    return [response.status, await response.json()] as [number, SessionHistoryResponse & { error?: { code: string } }];
  };
  const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
  const resume = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${app!.port}/api/sessions/resume`, { method: "POST", headers: { ...guard, ...headers }, body: JSON.stringify(body) });
    return [response.status, await response.json()] as [number, SessionResumeResponse & { error?: { code: string; message: string } }];
  };
  /** herdr up on `path`: tried when its folder changes, and at once again while it refuses (between bind and listen); bounded */
  const herdrUp = (path: string) => new Promise<void>((resolve, reject) => {
    let over = false;
    let trying = false;
    const finish = (error?: Error) => { if (over) return; over = true; clearTimeout(timer); watcher.close(); if (error) reject(error); else resolve(); };
    const attempt = async (): Promise<void> => {
      if (over || trying || !existsSync(path)) return;
      trying = true;
      try { await herdrRpc("ping", {}, path, 2_000); finish(); } catch { setImmediate(() => void attempt()); } finally { trying = false; }
    };
    const watcher = watch(dirname(path), () => void attempt());
    const timer = setTimeout(() => finish(new Error("the resume test's herdr did not start")), 15_000);
    void attempt();
  });
  /** A herdr session of its own on `path`, its shells handed `env` over the stand-in PATH and this HOME. */
  const startHerdr = async (session: string, configDir: string, path: string, env: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true });
    const started = Bun.spawn([herdr, "--session", session, "server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_") && name !== "CLAUDE_CONFIG_DIR")),
      ...testShellEnv(configDir), XDG_CONFIG_HOME: configDir, HOME: home, PATH: `${join(root, "bin")}:${saved.PATH ?? ""}`, ...env,
    } });
    await herdrUp(path);
    return started;
  };
  const stopHerdr = async (session: string, configDir: string, started: ReturnType<typeof Bun.spawn>) => {
    await Bun.spawn([herdr, "--session", session, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, XDG_CONFIG_HOME: configDir } }).exited;
    started.kill();
    await started.exited;
  };
  /** Reads `check` until it holds: once herdr's subscription starts, and again on each event of the pane; bounded */
  const untilPane = (pane: string, check: () => Promise<boolean>, what: string, start: () => Promise<unknown>) => new Promise<void>((resolve, reject) => {
    let over = false;
    let reading = false;
    let again = false;
    const finish = (error?: Error) => { if (over) return; over = true; clearTimeout(timer); subscription.close(); if (error) reject(error); else resolve(); };
    const read = async (): Promise<void> => {
      if (over) return;
      if (reading) { again = true; return; }
      reading = true;
      try { if (await check()) finish(); } catch (error) { finish(error as Error); } finally {
        reading = false;
        if (again && !over) { again = false; void read(); }
      }
    };
    const subscription = subscribeEvents([{ type: "pane.updated", pane_id: pane }, { type: "pane.agent_status_changed", pane_id: pane }], {
      onStarted: () => { start().then(() => read(), (error: Error) => finish(error)); },
      onEvent: () => void read(),
      onError: (error) => finish(error),
    }, socket);
    const timer = setTimeout(() => finish(new Error(`herdr never ${what}`)), 10_000);
  });

  beforeAll(async () => {
    if (!NATIVE) return;
    config = mkdtempSync("/tmp/hwr-");
    root = mkdtempSync(join(tmpdir(), "ovis-claude-resume-"));
    home = join(root, "home");
    alternate = join(root, "alternate-store");
    project = join(root, "project");
    socket = join(config, "herdr", "sessions", SESSION, "herdr.sock");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(alternate, { recursive: true });
    mkdirSync(project, { recursive: true });
    cwd = realpathSync(project);
    const reports = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(peer, data) {
      const report = JSON.parse(data.toString()) as Report;
      peer.end();
      const waiter = waiting.shift();
      if (waiter) waiter(report); else queued.push(report);
    } } });
    listener = reports;
    const bin = join(root, "bin");
    mkdirSync(join(root, "native"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(Bun.which("node")!, join(root, "native", "claude"));
    writeFileSync(join(root, "claude.cjs"), `
process.title = "claude";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const has = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CONFIG_DIR");
const store = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude");
const resumed = at >= 0 ? args[at + 1] : null;
if (resumed) fs.appendFileSync(path.join(store, "projects", ${JSON.stringify(claudeProjectDir(cwd))}, resumed + ".jsonl"), JSON.stringify({ type: "user", sessionId: resumed, message: { role: "user", content: "written by the resumed stand-in" } }) + "\\n");
require("node:net").connect(${reports.port}, "127.0.0.1", function () { this.end(JSON.stringify({ pid: process.pid, resumed, has, value: has ? process.env.CLAUDE_CONFIG_DIR : null })); });
// alive until its pane or herdr ends it, with or without a terminal on stdin (a background job has none)
setInterval(() => {}, 1 << 30);
`);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(join(root, "native", "claude"))} ${JSON.stringify(join(root, "claude.cjs"))} "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    writeSession(join(home, ".claude"), ID, "default store prompt");
    writeSession(alternate, ID, "alternate store prompt");
    // herdr's shells: the stand-in first on PATH, this HOME, and no CLAUDE_CONFIG_DIR of their own
    daemon = await startHerdr(SESSION, config, socket, {});
    // the server under test reads herdr, the default store and the variable from its own environment
    process.env["HERDR_SOCKET"] = socket;
    process.env["HOME"] = home;
    delete process.env["CLAUDE_CONFIG_DIR"];
    const appState = join(root, "app-state");
    mkdirSync(appState);
    writeFileSync(join(appState, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
    app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: appState });
    workspaceId = (await rpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd, label: "ovis-test-claude-resume", focus: false })).workspace.workspace_id;
    foreignWorkspace = (await rpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd, label: "ovis-test-claude-resume-other", focus: false })).workspace.workspace_id;
  }, 30_000);

  afterAll(async () => {
    app?.stop();
    restore("HERDR_SOCKET");
    restore("HOME");
    restore("CLAUDE_CONFIG_DIR");
    if (daemon) await stopHerdr(SESSION, config, daemon);
    listener?.stop(true);
    if (config !== "") rmSync(config, { recursive: true, force: true });
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!NATIVE)("real tab.create plus agent.start preserve Claude override presence and store", async () => {
    const before = readFileSync(transcript(join(home, ".claude"), ID), "utf8");
    // a pane whose processes herdr reports, none of them Claude: the server's default store, bound to it
    const shellOnly = (await rpc<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, cwd, focus: false })).root_pane.pane_id;
    const [shellStatus, shellList] = await list(shellOnly);
    expect([shellStatus, shellList.sessions.map((row) => [row.firstMessage, row.resume?.source?.pane_id])]).toEqual([200, [["default store prompt", shellOnly]]]);
    // an exported alternate store: listed from it, resumed in it, the variable still exported
    const exported = await sourcePane(alternate);
    const [status, listed] = await list(exported.pane);
    expect(status).toBe(200);
    expect(listed.sessions.map((row) => [row.id, row.firstMessage, row.resume?.source?.pane_id])).toEqual([[ID, "alternate store prompt", exported.pane]]);
    expect(JSON.stringify(listed)).not.toContain(alternate);
    const alternateKey = listed.sessions[0]!.resume!.source!.store_key;
    const tabs = await tabsOf(workspaceId);
    const [made, created] = await resume({ workspace_id: workspaceId, pane_id: exported.pane, agent: "claude", session_id: ID, store_key: alternateKey });
    expect([made, created.action, created.action === "created" && created.agent_started]).toEqual([200, "created", true]);
    expect(await nextReport()).toMatchObject({ resumed: ID, has: true, value: alternate });
    expect(readFileSync(transcript(alternate, ID), "utf8")).toContain("written by the resumed stand-in");
    expect(readFileSync(transcript(join(home, ".claude"), ID), "utf8")).toBe(before);
    expect(await tabsOf(workspaceId)).toBe(tabs + 1);

    // none exported, by herdr's shells either: the variable stays absent, not set to ~/.claude
    const implicit = await sourcePane(null);
    const [, implicitList] = await list(implicit.pane);
    expect(implicitList.sessions.map((row) => row.firstMessage)).toEqual(["default store prompt"]);
    const implicitKey = implicitList.sessions[0]!.resume!.source!.store_key;
    const [, second] = await resume({ workspace_id: workspaceId, pane_id: implicit.pane, agent: "claude", session_id: ID, store_key: implicitKey });
    expect(second.action).toBe("created");
    expect(await nextReport()).toMatchObject({ resumed: ID, has: false, value: null });
    expect(readFileSync(transcript(join(home, ".claude"), ID), "utf8")).toContain("written by the resumed stand-in");

    // ~/.claude exported by name: the same directory, another key, and the variable stays exported
    const named = await sourcePane(join(home, ".claude"));
    const [, namedList] = await list(named.pane);
    const namedKey = namedList.sessions[0]!.resume!.source!.store_key;
    expect(namedKey).not.toBe(implicitKey);
    const [, third] = await resume({ workspace_id: workspaceId, pane_id: named.pane, agent: "claude", session_id: ID, store_key: namedKey });
    expect(third.action).toBe("created");
    expect(await nextReport()).toMatchObject({ resumed: ID, has: true, value: join(home, ".claude") });

    // a pane herdr reports on the session, on the same store: Open, nothing made, herdr's focus unmoved
    await rpc("pane.report_agent_session", { pane_id: exported.pane, agent: "claude", source: "herdr:claude", seq: 1, agent_session_id: ID, session_start_source: "resume" });
    const focused = (await snapshotNow()).panes.find((pane) => pane.focused)?.pane_id;
    const counted = await tabsOf(workspaceId);
    const [, opened] = await resume({ workspace_id: workspaceId, pane_id: exported.pane, agent: "claude", session_id: ID, store_key: alternateKey });
    expect(opened).toEqual({ action: "opened", workspace_id: workspaceId, pane_id: exported.pane });
    expect(await tabsOf(workspaceId)).toBe(counted);
    expect((await snapshotNow()).panes.find((pane) => pane.focused)?.pane_id).toBe(focused);
    // the same id reported by that pane is not Open for a list read from another store: a new tab in that one
    const [, elsewhere] = await resume({ workspace_id: workspaceId, pane_id: implicit.pane, agent: "claude", session_id: ID, store_key: implicitKey });
    expect(elsewhere.action).toBe("created");
    expect(await nextReport()).toMatchObject({ resumed: ID, has: false });
  }, 90_000);

  it.skipIf(!NATIVE)("refuses a changed, foreign, forged, watch-only, unreadable or ambiguous source before any tab is made", async () => {
    const source = await sourcePane(alternate);
    const [, listed] = await list(source.pane);
    const key = listed.sessions[0]!.resume!.source!.store_key;
    const valid = { workspace_id: workspaceId, pane_id: source.pane, agent: "claude", session_id: ID, store_key: key };
    const foreignPane = (await snapshotNow()).panes.find((pane) => pane.workspace_id === foreignWorkspace)!.pane_id;
    const defaultBefore = readFileSync(transcript(join(home, ".claude"), ID), "utf8");
    const refusals: [number, unknown][] = [];
    // each refusal is answered before any tab is made
    const refused = async (body: Record<string, unknown>, expected: [number, string], headers: Record<string, string> = {}) => {
      const tabs = await tabsOf(workspaceId);
      const [status, answer] = await resume(body, headers);
      refusals.push([status, answer]);
      expect([status, answer.error?.code]).toEqual(expected);
      expect(await tabsOf(workspaceId)).toBe(tabs);
    };
    await refused(valid, [403, "read_only"], { "x-forwarded-for": "100.64.0.9", cookie: `ovis_device=${WATCH_TOKEN}` });
    await refused({ ...valid, pane_id: foreignPane }, [400, "pane_not_in_workspace"]);
    await refused({ ...valid, session_id: "../../outside" }, [400, "invalid_session_id"]);
    await refused({ ...valid, store_key: alternate }, [400, "invalid_store_key"]);
    await refused({ ...valid, store_key: "0".repeat(24) }, [409, "stale_source"]);
    await refused({ ...valid, session_id: OTHER }, [404, "session_not_found"]);
    await refused({ ...valid, agent: "codex" }, [400, "invalid_agent"]);
    // the listing pane's Claude restarted on the default store: the key no longer matches
    process.kill(source.report.pid);
    await rpc("pane.send_text", { pane_id: source.pane, text: "env -u CLAUDE_CONFIG_DIR claude\n" });
    await nextReport();
    await refused(valid, [409, "stale_source"]);
    // the listing pane gone
    const gone = await sourcePane(alternate);
    const [, goneList] = await list(gone.pane);
    await rpc("pane.close", { pane_id: gone.pane });
    await refused({ ...valid, pane_id: gone.pane, store_key: goneList.sessions[0]!.resume!.source!.store_key }, [409, "stale_source"]);
    // a named store that is not there: unreadable, never the default store in its place
    const unreadable = await sourcePane(join(root, "missing-store"));
    expect((await list(unreadable.pane))[0]).toBe(409);
    await refused({ ...valid, pane_id: unreadable.pane }, [409, "claude_store_unknown"]);
    // two Claudes in front of one pane: which one a session belongs to cannot be told
    const tab = await rpc<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, cwd, focus: false });
    // herdr's own process list catches up with the two a moment after they start: read it again on each of the pane's events until it does
    const claudes = async () => ((await rpc<{ process_info: { foreground_processes?: { name?: string }[] } }>("pane.process_info", { pane_id: tab.root_pane.pane_id })).process_info.foreground_processes ?? []).filter((entry) => entry.name === "claude").length;
    await untilPane(tab.root_pane.pane_id, async () => await claudes() >= 2, "listed both Claude processes", async () => {
      await rpc("pane.send_text", { pane_id: tab.root_pane.pane_id, text: `sh -c 'claude & CLAUDE_CONFIG_DIR=${alternate} claude; wait'\n` });
      await nextReport(); await nextReport();
    });
    expect((await list(tab.root_pane.pane_id))[0]).toBe(409);
    await refused({ ...valid, pane_id: tab.root_pane.pane_id }, [409, "claude_store_unknown"]);
    // nothing was started in the default store, and no refusal names a store or a prompt
    expect(readFileSync(transcript(join(home, ".claude"), ID), "utf8")).toBe(defaultBefore);
    expect(JSON.stringify(refusals)).not.toMatch(/alternate|prompt|missing-store/);
  }, 90_000);

  it.skipIf(!NATIVE)("a source shell without the override is no proof: herdr exporting one withholds Resume before any tab", async () => {
    // the implicit store's key, as a list from a pane with none exported gives it
    const implicitKey = (await list((await sourcePane(null)).pane))[1].sessions[0]!.resume!.source!.store_key;
    const exportedSession = "resume-exported";
    const exportedConfig = mkdtempSync("/tmp/hwr-");
    const exportedSocket = join(exportedConfig, "herdr", "sessions", exportedSession, "herdr.sock");
    const exportedRpc = <T,>(method: string, params: Record<string, unknown>) => herdrRpc<T>(method, params, exportedSocket);
    const defaultBefore = readFileSync(transcript(join(home, ".claude"), ID), "utf8");
    const alternateBefore = readFileSync(transcript(alternate, ID), "utf8");
    let exported: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // a herdr whose own environment exports the alternate store: every new tab of it inherits that
      exported = await startHerdr(exportedSession, exportedConfig, exportedSocket, { CLAUDE_CONFIG_DIR: alternate });
      process.env["HERDR_SOCKET"] = exportedSocket;
      const workspace = (await exportedRpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd, label: "ovis-test-claude-resume-exported", focus: false })).workspace.workspace_id;
      const pane = (await exportedRpc<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: workspace, cwd, focus: false })).root_pane.pane_id;
      // the pane's shell drops it before Claude starts: the pane alone says none exported
      await exportedRpc("pane.send_text", { pane_id: pane, text: "exec env -u CLAUDE_CONFIG_DIR /bin/sh -c 'claude; exec /bin/sh'\n" });
      expect(await nextReport()).toMatchObject({ has: false });
      const listed = await fetch(`http://127.0.0.1:${app!.port}/api/sessions/history?workspace_id=${encodeURIComponent(workspace)}&agent=claude&pane_id=${encodeURIComponent(pane)}`);
      const rows = ((await listed.json()) as SessionHistoryResponse).sessions;
      // the pane's own store is listed, but a new tab would start in herdr's: no Resume for it
      expect([listed.status, rows.map((row) => [row.firstMessage, row.resume?.source])]).toEqual([200, [["default store prompt", undefined]]]);
      const tabs = (await exportedRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.tabs.filter((tab) => tab.workspace_id === workspace).length;
      const [status, refused] = await resume({ workspace_id: workspace, pane_id: pane, agent: "claude", session_id: ID, store_key: implicitKey });
      expect([status, refused.error?.code]).toEqual([409, "launch_unsupported"]);
      expect((await exportedRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.tabs.filter((tab) => tab.workspace_id === workspace).length).toBe(tabs);
      expect(readFileSync(transcript(join(home, ".claude"), ID), "utf8")).toBe(defaultBefore);
      expect(readFileSync(transcript(alternate, ID), "utf8")).toBe(alternateBefore);
    } finally {
      process.env["HERDR_SOCKET"] = socket;
      if (exported) await stopHerdr(exportedSession, exportedConfig, exported);
      rmSync(exportedConfig, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!NATIVE)("answers another PC's Resume through the PC proxy, refusing a stale key there too", async () => {
    // a session no pane shows yet (the first test left one showing ID): Resume makes a tab for it
    const REMOTE = "00000000-0000-4000-8000-0000000000c3";
    writeSession(alternate, REMOTE, "remote store prompt");
    const source = await sourcePane(alternate);
    const bridgeState = mkdtempSync(join(tmpdir(), "ovis-claude-resume-bridge-"));
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: bridgeState, tailscaleOwner: null });
    try {
      const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
      const manager = { endpoint: (id: string) => id === "resume-remote" ? { url: `http://127.0.0.1:${bridge.port}`, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
      const listing = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/resume-remote/sessions/history?workspace_id=${encodeURIComponent(workspaceId)}&agent=claude&pane_id=${encodeURIComponent(source.pane)}`), manager);
      expect(listing.status).toBe(200);
      const key = ((await listing.json()) as SessionHistoryResponse).sessions.find((row) => row.id === REMOTE)!.resume!.source!.store_key;
      const tabs = await tabsOf(workspaceId);
      const post = (body: Record<string, unknown>) => handleMachineRequest(new Request("http://127.0.0.1/api/machines/resume-remote/sessions/resume", { method: "POST", headers: guard, body: JSON.stringify(body) }), manager);
      const stale = await post({ workspace_id: workspaceId, pane_id: source.pane, agent: "claude", session_id: REMOTE, store_key: "0".repeat(24) });
      expect([stale.status, ((await stale.json()) as ApiError).error.code]).toEqual([409, "stale_source"]);
      expect(await tabsOf(workspaceId)).toBe(tabs);
      const made = await post({ workspace_id: workspaceId, pane_id: source.pane, agent: "claude", session_id: REMOTE, store_key: key });
      expect(((await made.json()) as SessionResumeResponse).action).toBe("created");
      expect(await nextReport()).toMatchObject({ resumed: REMOTE, has: true, value: alternate });
      expect(await tabsOf(workspaceId)).toBe(tabs + 1);
    } finally {
      bridge.stop();
      rmSync(bridgeState, { recursive: true, force: true });
    }
  }, 60_000);
});

// The shared preferences (shared/preferences.ts) over HTTP and the event stream: the muted panes
// are always in the document, the first mute is a change of the empty list, a watching device
// reads and cannot write, and two tabs' changes land as two revisions with both kept.
/** a preferences document saved at least once, which names its state folder */
const namedPreferences = <T extends object>(doc: T) => ({ ...doc, state_id: expect.stringMatching(/^[0-9a-f]{32}$/) });

describe("shared preferences API", () => {
  const guard = { "x-herdr-machine": "1", "content-type": "application/json" };
  /** the event stream as a page reads it: each `preferences` document, and a bounded wait for the next one that matches */
  async function openEvents(base: string, headers: Record<string, string>, abort: AbortController) {
    const response = await fetch(`${base}/api/machines/events`, { headers, signal: abort.signal });
    expect(response.status).toBe(200);
    const documents: SharedPreferences[] = [];
    const listeners = new Set<() => void>();
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as MachineEvent;
          if (event.type === "preferences") { documents.push(event.preferences); for (const listener of [...listeners]) listener(); }
        }
      }
    })().catch(() => undefined);
    const next = (what: string, found: (document: SharedPreferences) => boolean): Promise<SharedPreferences> => new Promise((resolve, reject) => {
      const check = () => { const hit = documents.find(found); if (hit) { listeners.delete(check); clearTimeout(timer); resolve(hit); } };
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`timed out waiting for ${what}`)); }, 10_000);
      listeners.add(check);
      check();
    });
    return { documents, next };
  }

  it("advertises the mute list from the first document on, saves the first mute, and refuses what is not a list", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-preferences-"));
    const server = createServer({ port: 0, stateDir: root, token: "test-preferences", tailscaleOwner: null });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { ...guard, authorization: "Bearer test-preferences" };
    const put = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { ...headers, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const abort = new AbortController();
    try {
      // a fresh store: the empty list is in the GET and in the stream's opening document
      expect(await (await fetch(`${base}/api/preferences`, { headers })).json()).toEqual({ revision: 0, settings: {}, muted_panes: [] });
      const events = await openEvents(base, headers, abort);
      expect(await events.next("the opening document", (document) => document.revision === 0)).toEqual({ revision: 0, settings: {}, muted_panes: [] });
      // the first mute: saved, answered whole, and told to every stream
      const first = await put({ settings: {}, muted_panes: ["w1:p1"] });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(namedPreferences({ revision: 1, settings: {}, muted_panes: ["w1:p1"] }));
      expect(await events.next("the first mute", (document) => document.revision === 1)).toEqual(namedPreferences({ revision: 1, settings: {}, muted_panes: ["w1:p1"] }));
      // malformed and oversized lists: refused unread into the document, which keeps its revision
      for (const muted of ["w1:p1", [1], [""], [null], ["x".repeat(301)], Array.from({ length: MAX_MUTED_PANES + 1 }, (_, i) => `w1:p${i}`)]) {
        const refused = await put({ settings: {}, muted_panes: muted });
        expect([JSON.stringify(muted).slice(0, 24), refused.status, ((await refused.json()) as ApiError).error.code]).toEqual([JSON.stringify(muted).slice(0, 24), 400, "invalid_body"]);
      }
      const huge = await put({ settings: {}, muted_panes: Array.from({ length: 300 }, (_, i) => `${"k".repeat(290)}${i}`) });
      expect([huge.status, ((await huge.json()) as ApiError).error.code]).toEqual([413, "too_large"]);
      expect(await (await fetch(`${base}/api/preferences`, { headers })).json()).toEqual(namedPreferences({ revision: 1, settings: {}, muted_panes: ["w1:p1"] }));
      // a change that names no list leaves it; an empty list clears it
      expect(await (await put({ settings: { theme: "light" } })).json()).toEqual(namedPreferences({ revision: 2, settings: { theme: "light" }, muted_panes: ["w1:p1"] }));
      expect(await (await put({ settings: {}, muted_panes: [] })).json()).toEqual(namedPreferences({ revision: 3, settings: { theme: "light" }, muted_panes: [] }));
      await events.next("the cleared list", (document) => document.revision === 3);
      expect(events.documents.map((document) => document.revision)).toEqual([0, 1, 2, 3]);
    } finally {
      abort.abort();
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a document from before the list as none muted, without a write, and takes the first mute of it", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-preferences-"));
    const stored = { revision: 4, settings: { theme: "dark" }, pins: ["local:w1:p1"] };
    writeFileSync(join(root, "preferences.json"), JSON.stringify(stored));
    const server = createServer({ port: 0, stateDir: root, token: "test-preferences", tailscaleOwner: null });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { ...guard, authorization: "Bearer test-preferences" };
    const abort = new AbortController();
    try {
      expect(await (await fetch(`${base}/api/preferences`, { headers })).json()).toEqual({ ...stored, muted_panes: [] });
      expect(JSON.parse(readFileSync(join(root, "preferences.json"), "utf8"))).toEqual(stored);
      const events = await openEvents(base, headers, abort);
      expect(await events.next("the opening document", (document) => document.revision === 4)).toEqual({ ...stored, muted_panes: [] });
      const first = await fetch(`${base}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }) });
      expect(await first.json()).toEqual(namedPreferences({ revision: 5, settings: { theme: "dark" }, pins: ["local:w1:p1"], muted_panes: ["w1:p1"] }));
      // the list has a document of its own, which an older release's whole rewrite of preferences.json cannot erase
      expect(JSON.parse(readFileSync(join(root, "preferences.json"), "utf8"))).toEqual({ revision: 5, settings: { theme: "dark" }, pins: ["local:w1:p1"] });
      expect(JSON.parse(readFileSync(join(root, "muted-panes.json"), "utf8"))).toEqual({ muted_panes: ["w1:p1"] });
    } finally {
      abort.abort();
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps both of two tabs' changes as two revisions, and lets a watching device read but not write", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-preferences-"));
    const devices = new DeviceStore(root);
    const watch = devices.pair(devices.startPairing().code, "Watch", "watch")!;
    devices.match(watch.token);
    const server = createServer({ port: 0, stateDir: root, token: "test-preferences", tailscaleOwner: null });
    const base = `http://127.0.0.1:${server.port}`;
    const driving = { ...guard, authorization: "Bearer test-preferences" };
    const watching = { ...guard, cookie: `ovis_device=${watch.token}` };
    const abort = new AbortController();
    try {
      const events = await openEvents(base, watching, abort);
      await events.next("the opening document", (document) => document.revision === 0);
      // tab A mutes while tab B picks a theme: each change lands on the document as it is then, and neither is lost
      const [a, b] = await Promise.all([
        fetch(`${base}/api/preferences`, { method: "PUT", headers: driving, body: JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }) }),
        fetch(`${base}/api/preferences`, { method: "PUT", headers: driving, body: JSON.stringify({ settings: { theme: "light" } }) }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const revisions = [((await a.json()) as SharedPreferences).revision, ((await b.json()) as SharedPreferences).revision].sort();
      expect(revisions).toEqual([1, 2]);
      const merged = await events.next("both changes", (document) => document.revision === 2);
      expect(merged).toEqual(namedPreferences({ revision: 2, settings: { theme: "light" }, muted_panes: ["w1:p1"] }));
      // tab B then clears the list tab A set: the last write wins, as for every field
      const cleared = await fetch(`${base}/api/preferences`, { method: "PUT", headers: driving, body: JSON.stringify({ settings: {}, muted_panes: [] }) });
      expect(await cleared.json()).toEqual(namedPreferences({ revision: 3, settings: { theme: "light" }, muted_panes: [] }));
      // the watching device heard every document, and cannot write one: the revision stays
      await events.next("the cleared list", (document) => document.revision === 3);
      expect(events.documents.map((document) => document.revision)).toEqual([0, 1, 2, 3]);
      expect(await (await fetch(`${base}/api/preferences`, { headers: watching })).json()).toEqual(namedPreferences({ revision: 3, settings: { theme: "light" }, muted_panes: [] }));
      const refused = await fetch(`${base}/api/preferences`, { method: "PUT", headers: watching, body: JSON.stringify({ settings: {}, muted_panes: ["w1:p1"] }) });
      expect([refused.status, ((await refused.json()) as ApiError).error.code]).toEqual([403, "read_only"]);
      expect(await (await fetch(`${base}/api/preferences`, { headers: driving })).json()).toMatchObject({ revision: 3, muted_panes: [] });
    } finally {
      abort.abort();
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("access facts on /api/health", () => {
  type Body = { auth: HealthAuth; lan_exposure?: LanExposure; security?: SecuritySummary; herdr_core?: HerdrCoreFacts; herdr_runtime?: HerdrRuntimeFacts };
  const SECRET = "fictional-t0k3n-value";
  const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
  /** a server of its own: a temp state dir, an empty token unless one is given, nothing from the runner's environment */
  const CORE_FACTS: HerdrCoreFacts = { version: "0.1.17", session: "default", running: false };
  const serve = (options: { hostname?: string; token?: string; serveOnly?: boolean; owner?: string | null; seed?: (stateDir: string) => void; runtime?: RuntimeService; accepted?: () => boolean; bridgeToken?: string } = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-security-summary-"));
    options.seed?.(stateDir);
    const instance = createServer({ port: 0, hostname: options.hostname ?? "127.0.0.1", token: options.token ?? "", stateDir, ...(options.bridgeToken ? { bridgeToken: options.bridgeToken } : {}), tailscaleOwner: options.owner ?? null, tailscaleServeOnly: options.serveOnly ?? false, herdrCoreFacts: () => CORE_FACTS, ...(options.runtime ? { runtimeService: options.runtime } : {}), ...(options.accepted ? { launchAccepted: options.accepted } : {}) });
    const read = async (headers: Record<string, string> = {}, scope = "") => {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/health${scope}`, { headers });
      const text = await response.text();
      return { status: response.status, cacheControl: response.headers.get("cache-control"), text, body: JSON.parse(text) as Body };
    };
    return { port: instance.port, stateDir, read, stop: () => { instance.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
  };

  it("authenticated summary contains only safe facts", async () => {
    const secured = serve({ token: SECRET });
    try {
      for (const scope of ["", "?scope=bridge"]) {
        const answer = await secured.read({ authorization: `Bearer ${SECRET}` }, scope);
        expect(answer.status).toBe(200);
        expect(answer.body.security).toEqual({ token_configured: true, pairing_gate: "open", bind_scope: "loopback", observed_ingress: "direct", public_exposure: "unknown" });
        expect(answer.cacheControl).toBe("no-store");
        // no token, hash, login, address or path anywhere in the facts
        const facts = JSON.stringify(answer.body.security);
        for (const secret of [SECRET, secured.stateDir, "127.0.0.1", "token_hash", "@"]) expect(facts).not.toContain(secret);
        expect(answer.text).not.toContain(SECRET);
      }
    } finally { secured.stop(); }
    // another bind and a closed gate: the facts follow the configuration, not the request
    const open = serve({ hostname: "0.0.0.0" });
    try {
      expect((await open.read()).body.security).toEqual({ token_configured: false, pairing_gate: "open", bind_scope: "other", observed_ingress: "direct", public_exposure: "unknown" });
      const { code } = (await (await fetch(`http://127.0.0.1:${open.port}/api/devices/pair/start`, { method: "POST", headers: guard })).json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${open.port}/api/devices/pair`, { method: "POST", headers: { ...guard, "x-forwarded-for": "100.64.0.9" }, body: JSON.stringify({ code, label: "Phone" }) });
      const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
      // the first use of the cookie confirms the pairing, which closes the gate for good
      expect((await open.read({ cookie })).body.auth).toMatchObject({ authenticated: true, via: "device" });
      const closed = (await open.read()).body;
      expect(closed.security).toMatchObject({ pairing_gate: "closed", bind_scope: "other" });
      expect(closed.lan_exposure).toBeUndefined();
    } finally { open.stop(); }
  });

  it("anonymous health omits security", async () => {
    const secured = serve({ token: SECRET, hostname: "0.0.0.0" });
    try {
      const anonymous: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { "x-forwarded-for": "203.0.113.7", "tailscale-funnel-request": "?1" }];
      for (const headers of anonymous) {
        for (const scope of ["", "?scope=bridge"]) {
          const answer = await secured.read(headers, scope);
          expect(answer.body.auth.authenticated).toBe(false);
          expect(answer.body.security).toBeUndefined();
          for (const name of ["token_configured", "pairing_gate", "bind_scope", "observed_ingress", "public_exposure", "0.0.0.0"]) expect(answer.text).not.toContain(name);
        }
      }
    } finally { secured.stop(); }
  });

  it("tells herdr-core's facts to a signed-in client only, and not on a bridge poll", async () => {
    const secured = serve({ token: SECRET, hostname: "0.0.0.0" });
    try {
      const bearer = { authorization: `Bearer ${SECRET}` };
      const signedIn = await secured.read(bearer);
      expect(signedIn.body.auth.authenticated).toBe(true);
      expect(signedIn.body.herdr_core).toEqual(CORE_FACTS);
      expect((await secured.read(bearer, "?scope=bridge")).body.herdr_core).toBeUndefined();
      const anonymous = await secured.read({});
      expect(anonymous.body.auth.authenticated).toBe(false);
      expect(anonymous.body.herdr_core).toBeUndefined();
    } finally { secured.stop(); }
  });

  it("tells herdr-core's facts to a driving owner only: not a watching device, nor a caller on an open install", async () => {
    let token = "";
    const secured = serve({ token: SECRET, seed: (stateDir) => {
      const store = new DeviceStore(stateDir);
      token = store.pair(store.startPairing().code, "Watch", "watch")!.token;
      store.match(token);
    } });
    try {
      const watching = await secured.read({ cookie: `ovis_device=${token}`, "x-forwarded-for": "192.168.0.20" });
      expect(watching.body.auth).toMatchObject({ authenticated: true, role: "watch" });
      expect(watching.body.herdr_core).toBeUndefined();
      expect((await secured.read({ authorization: `Bearer ${SECRET}` })).body.herdr_core).toEqual(CORE_FACTS);
    } finally { secured.stop(); }
    const open = serve({ hostname: "0.0.0.0" });
    try {
      const stranger = await open.read({ "x-forwarded-for": "192.168.0.20" });
      expect(stranger.body.auth).toMatchObject({ authenticated: true, via: "open" });
      expect(stranger.body.herdr_core).toBeUndefined();
      expect((await open.read({})).body.herdr_core).toEqual(CORE_FACTS);
    } finally { open.stop(); }
  });

  it("says in the bridge's own answer which runtime it serves and whether its launcher took it", async () => {
    let taken = false;
    const server = serve({ accepted: () => taken });
    try {
      const first = (await server.read({}, "?scope=bridge")).body as unknown as { runtime?: string; accepted?: boolean; web_ui?: { boot_id?: string } };
      expect([first.runtime, first.accepted, typeof first.web_ui?.boot_id]).toEqual(["herdr", false, "string"]);
      taken = true;
      expect(((await server.read({}, "?scope=bridge")).body as unknown as { accepted?: boolean }).accepted).toBe(true);
    } finally { server.stop(); }
  });

  it("tells the runtime facts to a driving owner only, and takes a switch from that owner's own page only", async () => {
    const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: true, switch_to: "herdr-core", locked: null };
    const asked: unknown[] = [];
    let answer: SwitchAnswer = { ok: true };
    const runtime: RuntimeService = { facts: () => facts, request: (target) => { asked.push(target); return answer; } };
    let token = "";
    const secured = serve({ token: SECRET, runtime, bridgeToken: "fictional-bridge-token", seed: (stateDir) => {
      const store = new DeviceStore(stateDir);
      token = store.pair(store.startPairing().code, "Watch", "watch")!.token;
      store.match(token);
    } });
    const bearer = { authorization: `Bearer ${SECRET}` };
    const post = (headers: Record<string, string>, body: unknown = { runtime: "herdr-core" }) =>
      fetch(`http://127.0.0.1:${secured.port}/api/runtime`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      expect((await secured.read(bearer)).body.herdr_runtime).toEqual(facts);
      expect((await secured.read({ cookie: `ovis_device=${token}`, "x-forwarded-for": "192.168.0.20" })).body.herdr_runtime).toBeUndefined();
      expect((await secured.read({})).body.herdr_runtime).toBeUndefined();
      // the bridge's own answer, which needs no herdr, tells the same owner the same, so a stopped TUI keeps the way back
      expect((await secured.read(bearer, "?scope=bridge")).body.herdr_runtime).toEqual(facts);
      expect((await secured.read({ cookie: `ovis_device=${token}`, "x-forwarded-for": "192.168.0.20" }, "?scope=bridge")).body.herdr_runtime).toBeUndefined();
      expect((await secured.read({}, "?scope=bridge")).body.herdr_runtime).toBeUndefined();
      // the connection server reaching this PC with its bridge token shows its move badge from them
      for (const scope of ["", "?scope=bridge"]) expect((await secured.read({ authorization: "Bearer fictional-bridge-token" }, scope)).body.herdr_runtime).toEqual(facts);
      // nobody but a driving owner, and only through the app's own request header
      expect((await post({})).status).toBe(401);
      expect((await post({ cookie: `ovis_device=${token}`, "x-forwarded-for": "192.168.0.20", "x-herdr-update": "1" })).status).toBe(403);
      expect((await post(bearer)).status).toBe(403);
      expect(asked).toEqual([]);
      const accepted = await post({ ...bearer, "x-herdr-update": "1" });
      expect([accepted.status, await accepted.json()]).toEqual([202, { accepted: true }]);
      expect(asked).toEqual(["herdr-core"]);
      // the service's refusal reaches the page as it is
      answer = { ok: false, status: 409, code: "runtime_locked", message: "OVIS_RUNTIME decides" };
      const refused = await post({ ...bearer, "x-herdr-update": "1" }, { runtime: "herdr" });
      expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "runtime_locked"]);
      expect((await fetch(`http://127.0.0.1:${secured.port}/api/runtime`, { headers: bearer })).status).toBe(400);
    } finally { secured.stop(); }
    // an open install lets a stranger on the network in as a driver: still no switch for them
    asked.length = 0;
    answer = { ok: true };
    const open = serve({ hostname: "0.0.0.0", runtime });
    try {
      const stranger = await fetch(`http://127.0.0.1:${open.port}/api/runtime`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1", "x-forwarded-for": "192.168.0.20" }, body: JSON.stringify({ runtime: "herdr-core" }) });
      expect(stranger.status).toBe(403);
      expect((await open.read({ "x-forwarded-for": "192.168.0.20" })).body.herdr_runtime).toBeUndefined();
      expect(asked).toEqual([]);
    } finally { open.stop(); }
  });

  it("watch can read but not change access", async () => {
    let token = "";
    const secured = serve({ token: SECRET, seed: (stateDir) => {
      const store = new DeviceStore(stateDir);
      token = store.pair(store.startPairing().code, "Watch", "watch")!.token;
      store.match(token);
    } });
    try {
      const cookie = `ovis_device=${token}`;
      const answer = await secured.read({ cookie, "x-forwarded-for": "192.168.0.20" });
      expect(answer.body.auth).toMatchObject({ authenticated: true, via: "device", role: "watch" });
      expect(answer.body.security).toEqual({ token_configured: true, pairing_gate: "closed", bind_scope: "loopback", observed_ingress: "proxy", public_exposure: "unknown" });
      // the facts change nothing: pairing, renaming and revoking stay refused to a watching device
      const list = (await (await fetch(`http://127.0.0.1:${secured.port}/api/devices`, { headers: { cookie } })).json()) as { devices: Array<{ id: string }> };
      const id = list.devices[0]!.id;
      for (const [method, path] of [["POST", "pair/start"], ["PATCH", id], ["DELETE", id]] as const) {
        const response = await fetch(`http://127.0.0.1:${secured.port}/api/devices/${path}`, { method, headers: { ...guard, cookie }, body: method === "DELETE" ? undefined : "{}" });
        expect([method, response.status]).toEqual([method, 403]);
      }
      expect((await secured.read({ cookie })).body.security).toMatchObject({ pairing_gate: "closed" });
    } finally { secured.stop(); }
  });

  it("corrupt registry is unavailable and gated", async () => {
    const damaged = serve({ hostname: "0.0.0.0", seed: (stateDir) => writeFileSync(join(stateDir, "devices.json"), "{ not json") });
    try {
      const answer = await damaged.read();
      expect(answer.body.security).toEqual({ token_configured: false, pairing_gate: "unavailable", bind_scope: "other", observed_ingress: "direct", public_exposure: "unknown" });
      // a damaged registry is not a first installation: no open-LAN warning, and a stranger is refused
      expect(answer.body.lan_exposure).toBeUndefined();
      const stranger = await damaged.read({ "x-forwarded-for": "192.168.0.20" });
      expect(stranger.body.auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect(stranger.body.security).toBeUndefined();
      expect(answer.text).not.toContain(damaged.stateDir);
    } finally { damaged.stop(); }
  });

  it("auth via is not ingress", async () => {
    const OWNER = "owner@example.com";
    const bearer = { authorization: `Bearer ${SECRET}` };
    const tailscaleShape = { ...bearer, "x-forwarded-for": "100.64.0.9", "tailscale-user-login": OWNER };
    // the same token, three different ways in; Tailscale's header shape alone is no proof: any
    // client on this PC can send it unless serve is declared the only ingress
    const cases: Array<[boolean, Record<string, string>, SecuritySummary["observed_ingress"]]> = [
      [false, bearer, "direct"],
      [false, { ...bearer, "x-forwarded-for": "203.0.113.7" }, "proxy"],
      [false, tailscaleShape, "unknown"],
      [false, { ...bearer, "x-forwarded-for": "100.64.0.99", "tailscale-user-login": "unverified@example.test" }, "unknown"],
      [true, tailscaleShape, "tailscale"],
    ];
    for (const [serveOnly, headers, ingress] of cases) {
      const secured = serve({ token: SECRET, owner: OWNER, serveOnly });
      try {
        const body = (await secured.read(headers)).body;
        expect(body.auth).toMatchObject({ authenticated: true, via: "token" });
        expect([serveOnly, headers, body.security?.observed_ingress]).toEqual([serveOnly, headers, ingress]);
      } finally { secured.stop(); }
    }
    // and a local sign-in is not "direct" because of its via: a rewritten Host is a proxy on this PC
    const open = serve();
    try {
      const body = (await open.read({ host: "pc.example.com" })).body;
      expect(body.auth).toMatchObject({ authenticated: true, via: "open" });
      expect(body.security?.observed_ingress).toBe("proxy");
    } finally { open.stop(); }
  });

  it("unknown proxy never means local only", async () => {
    // a loopback bind behind some proxy on this PC: nothing proves where that proxy listens
    const behind = serve();
    try {
      const answer = await behind.read({ "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" });
      expect(answer.body.security).toEqual({ token_configured: false, pairing_gate: "open", bind_scope: "loopback", observed_ingress: "proxy", public_exposure: "unknown" });
      expect(answer.body.lan_exposure).toBeUndefined();
      // a Tailscale header nothing here could have written stays unknown, and so does exposure
      const forged = await behind.read({ "x-forwarded-for": "203.0.113.7", "tailscale-user-login": "someone@example.com" });
      expect(forged.body.security).toMatchObject({ observed_ingress: "unknown", public_exposure: "unknown" });
    } finally { behind.stop(); }
    // Funnel counts as public evidence only where serve is declared the only ingress
    const funnelHeaders = { authorization: `Bearer ${SECRET}`, "x-forwarded-for": "203.0.113.7", "tailscale-funnel-request": "?1" };
    const undeclared = serve({ token: SECRET, owner: "owner@example.com" });
    try {
      expect((await undeclared.read(funnelHeaders)).body.security).toMatchObject({ observed_ingress: "unknown", public_exposure: "unknown" });
    } finally { undeclared.stop(); }
    const declared = serve({ token: SECRET, owner: "owner@example.com", serveOnly: true });
    try {
      expect((await declared.read(funnelHeaders)).body.security).toMatchObject({ observed_ingress: "funnel", public_exposure: "observed" });
    } finally { declared.stop(); }
  });

  it("bridge health does not require herdr", async () => {
    const secured = serve({ token: SECRET });
    const saved = process.env.HERDR_SOCKET;
    const missing = join(secured.stateDir, "no-herdr.sock");
    process.env.HERDR_SOCKET = missing;
    try {
      const bridge = await secured.read({ authorization: `Bearer ${SECRET}` }, "?scope=bridge");
      expect(bridge.status).toBe(200);
      expect(bridge.body.security).toEqual({ token_configured: true, pairing_gate: "open", bind_scope: "loopback", observed_ingress: "direct", public_exposure: "unknown" });
      // the full answer needs herdr, and its failure carries no facts to be reused
      const full = await secured.read({ authorization: `Bearer ${SECRET}` });
      expect(full.status).not.toBe(200);
      expect(full.body.security).toBeUndefined();
      expect(full.text).not.toContain(SECRET);
    } finally {
      if (saved === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = saved;
      secured.stop();
    }
  });
});
