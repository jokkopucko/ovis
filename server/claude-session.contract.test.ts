import { afterAll, beforeAll, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { claudePaneSession, forgetTranscriptState } from "./conversation.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { startFakePushService } from "./push.fake.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse, HerdrPane, OmoActivity, PanePlan, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

// Real foreground processes and native PID records, without hooks or a model request.
const root = mkdtempSync(join(tmpdir(), "herdr-claude-session-"));
const originalHome = process.env["HOME"];
const originalConfigDir = process.env["CLAUDE_CONFIG_DIR"];
const NATIVE = process.platform === "linux" || process.platform === "darwin";
const workspaces: string[] = [];
const FIRST = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
const SECOND = "f2f55dc4-50ad-478c-a641-bf21268a1bba";
const NEXT = "9343d82a-890c-4a39-a4a7-33c017d496f1";
const UNWRITTEN = "5b0c7f1e-3d2a-4c8b-9e6f-0a1b2c3d4e5f";
const project = join(root, ".claude", "projects", claudeProjectDir(root));
let server: ReturnType<typeof createServer>;
let first: { pane: string; pid: number };
let second: { pane: string; pid: number };
let statusClock = Date.now();

function makeServer() {
  return createServer({
    port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
    pushLoopbackHttp: true, statusNow: () => statusClock,
    alertTiming: { short: 0, long: 0, longTurn: 1000 },
    backgroundWait: { grace: 1500, limit: 60_000 },
  });
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

class Frames {
  readonly seen: ServerMessage[] = [];
  readonly socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.addEventListener("message", (event) => this.seen.push(JSON.parse(String(event.data))));
  }

  wait(check: (frame: ServerMessage) => boolean, from = this.seen.length): Promise<ServerMessage> {
    const known = this.seen.slice(from).find(check);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const finish = (frame?: ServerMessage) => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", receive);
        if (frame) resolve(frame);
        else reject(new Error(`Frame timed out: ${JSON.stringify(this.seen.slice(-5))}`));
      };
      const receive = (event: MessageEvent) => {
        const frame: ServerMessage = JSON.parse(String(event.data));
        if (check(frame)) finish(frame);
      };
      const timer = setTimeout(() => finish(), 10_000);
      this.socket.addEventListener("message", receive);
    });
  }

  static async connect(port: number): Promise<Frames> {
    const frames = new Frames(port);
    await frames.wait((frame) => frame.type === "snapshot", 0);
    return frames;
  }
}

function transcript(id: string, store = join(root, ".claude"), answer = `Answer ${id}`): void {
  const folder = join(store, "projects", claudeProjectDir(root));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), [
    { type: "user", message: { content: `Prompt ${id}` } },
    { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
}

async function pane(id: string, configDir?: string): Promise<{ pane: string; pid: number }> {
  const created = await herdrRpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd: root, label: "ovis-test-claude-session", focus: false });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  let ready: (pid: number) => void = () => {};
  const signal = new Promise<number>((resolve) => { ready = resolve; });
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket, data) { ready(Number(data.toString())); socket.end(); } },
  });
  const node = configDir ? join(root, "claude") : Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  const timeout = setTimeout(() => ready(0), 10_000);
  try {
    await herdrRpc("pane.send_text", {
      pane_id: paneId, text: `exec env ${configDir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}` : "-u CLAUDE_CONFIG_DIR"} ${JSON.stringify(node)} ${JSON.stringify(join(root, "claude.cjs"))} ${JSON.stringify(root)} ${id} ${listener.port}\n`,
    });
    const pid = await signal;
    if (!pid) throw new Error("Claude stand-in did not signal readiness");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    return { pane: paneId, pid };
  } finally { clearTimeout(timeout); listener.stop(true); }
}

beforeAll(async () => {
  if (!NATIVE) return;
  delete process.env["CLAUDE_CONFIG_DIR"];
  forgetTranscriptState();
  const node = Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  // A native executable keeps its environment visible on macOS. Node's process.title setter
  // erases the environment that ps can see there, so use the renamed executable for that case.
  // Bun is self-contained on macOS; a copied Homebrew Node needs its original dylib location.
  copyFileSync(process.platform === "darwin" ? process.execPath : node, join(root, "claude"));
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".claude", "sessions"), { recursive: true });
  for (const id of [FIRST, SECOND, NEXT]) transcript(id);
  writeFileSync(join(root, "claude.cjs"), `
const fs = require("node:fs");
const net = require("node:net");
const [home, sessionId, port] = process.argv.slice(2);
if (process.platform === "linux" || !process.env.CLAUDE_CONFIG_DIR) process.title = "claude";
const procStart = process.platform === "linux"
  ? fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19]
  : require("node:child_process").execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
const store = process.env.CLAUDE_CONFIG_DIR || home + "/.claude";
fs.mkdirSync(store + "/sessions", { recursive: true });
fs.writeFileSync(store + "/sessions/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId, cwd: home, procStart, kind: "interactive",
}));
net.connect(Number(port), "127.0.0.1", function () { this.end(String(process.pid)); });
process.stdin.resume();
`);
  first = await pane(FIRST);
  second = await pane(SECOND);
  process.env["HOME"] = root;
  // alerts and the hold on a turn's background work wait moments, not minutes: a test sees what goes out, and what does not
  server = makeServer();
  await bounded(server.statusReady, "Initial status subscription");
}, 15_000);

afterAll(async () => {
  server?.stop();
  forgetTranscriptState();
  if (originalConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
});

/** Polls `check` for up to 10 s, then asserts it: the server answers what it knows now, and knows more later. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await Bun.sleep(100);
  expect(await check()).toBe(true);
}

async function read(paneId: string): Promise<ConversationResponse> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json();
}

it.skipIf(!NATIVE)("reads each hookless Claude pane's own conversation in a shared cwd", async () => {
  // The pane has no session id from Herdr; cwd and recency cannot distinguish these.
  const info = await herdrRpc<{ agent: { agent_session?: unknown } }>("agent.get", { target: first.pane });
  expect(info.agent.agent_session).toBeUndefined();
  const a = await read(first.pane);
  const b = await read(second.pane);
  expect(a.source).toBe("claude-transcript");
  expect(a.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
  expect(b.source).toBe("claude-transcript");
  expect(b.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${SECOND}` });
});

it.skipIf(!NATIVE)("lists a Claude pane's subagents, counts the running ones and pushes the count without a status", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const tasks = async (paneId: string): Promise<OmoActivity> => await (await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`)).json();
  const counted = async (paneId: string): Promise<number | undefined> => {
    const { snapshot } = await (await fetch(`${base}/api/session`)).json() as { snapshot: { panes: { pane_id: string; background_tasks?: number }[] } };
    return snapshot.panes.find((entry) => entry.pane_id === paneId)?.background_tasks;
  };
  const frames = await Frames.connect(server.port);
  const folder = join(project, SECOND, "subagents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review the parser", toolUseId: "toolu_a1", requestShape: "background" }));
  writeFileSync(join(folder, "agent-a1.jsonl"), `${JSON.stringify({ isSidechain: true, agentId: "a1", type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "go" } })}\n`);

  // a device that wants every alert: a count that changes alone must not reach it
  const device = await startFakePushService();
  try {
    const subscribed = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription, alerts: { input: true, done: "always" } }) });
    expect(subscribed.status).toBe(204);
    // asked: the server finds the pane's transcript itself. Its background lookup may already have come up empty
    // (herdr busy or late under load), which it does not repeat for a few seconds: the list follows once it looks again,
    // as the client's own retries see it
    await until(async () => (await tasks(second.pane)).tasks.some((task) => task.id === "a1" && task.status === "running"));
    expect((await tasks(second.pane)).tasks).toMatchObject([{ id: "a1", status: "running" }]);
    // from the first frame: the count may have been pushed while the list was polled
    await frames.wait((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks === 1, 0);
    expect(await counted(second.pane)).toBe(1);
    expect(await tasks(second.pane)).toMatchObject({ tasks: [{ id: "a1", title: "Review the parser", category: "reviewer", status: "running" }], runs: [] });
    // a pane with no subagents has no count and no list
    expect(await counted(first.pane)).toBeUndefined();
    expect((await tasks(first.pane)).tasks).toEqual([]);

    // the agent ends: its notification is written to the session's transcript
    const notice = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_a1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Review the parser\" finished</summary>\n<result>fine</result>\n</task-notification>";
    const endedFrame = frames.wait((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks === 0);
    appendFileSync(join(project, `${SECOND}.jsonl`), `\n${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(Date.now() + 1000).toISOString(), content: notice })}\n`);
    await endedFrame;
    expect(await counted(second.pane)).toBeUndefined();
    expect((await tasks(second.pane)).tasks).toMatchObject([{ id: "a1", status: "completed" }]);
    // pushed as a count alone: the pane's status is the one it had, and it counts as no turn
    const pushed = frames.seen.filter((frame) => frame.type === "pane-status" && frame.pane_id === second.pane && frame.background_tasks !== undefined);
    expect(pushed.at(-1)).toMatchObject({ background_tasks: 0, agent_status: expect.stringMatching(/^(idle|done)$/) });
    const conversation = await read(second.pane);
    expect(conversation.source).toBe("claude-transcript");
    expect(conversation.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result")).toMatchObject([{ kind: "task_result", tasks: [{ id: "a1", status: "completed", result: "fine" }] }]);
    // A later collector alert waits through the same delivery queue as any earlier alert.
    const barrier = device.waitFor((push) => push.payload.pane_id === first.pane, "input alert barrier", 10_000);
    await herdrRpc("pane.report_agent", { pane_id: first.pane, source: "manual", agent: "claude", state: "blocked" });
    await barrier;
    expect(device.received.map((push) => push.payload.pane_id)).toEqual([first.pane]);
  } finally {
    frames.socket.close();
    await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: device.subscription.endpoint }) }).catch(() => undefined);
    await herdrRpc("pane.report_agent", { pane_id: first.pane, source: "manual", agent: "claude", state: "idle" });
    device.stop();
  }
}, 25_000);

/** Each hold owns its pane, transcript and bridge, so running one test never needs an earlier one. */
async function backgroundTurn(taskId: string) {
  server.stop();
  forgetTranscriptState();
  const sessionId = crypto.randomUUID();
  transcript(sessionId);
  const target = await pane(sessionId);
  statusClock = Date.now();
  server = makeServer();
  await bounded(server.statusReady, "Background status subscription");
  const base = `http://127.0.0.1:${server.port}`;
  const device = await startFakePushService();
  const frames = await Frames.connect(server.port);
  const status = (frame: ServerMessage): frame is Extract<ServerMessage, { type: "pane-status" }> => frame.type === "pane-status" && frame.pane_id === target.pane;
  const shown = async (): Promise<HerdrPane | undefined> => {
    const response = await fetch(`${base}/api/session`);
    expect(response.status).toBe(200);
    const { snapshot }: { snapshot: SessionSnapshot } = await response.json();
    return snapshot.panes.find((entry) => entry.pane_id === target.pane);
  };
  const report = async (state: "working" | "idle") => {
    const frame = frames.wait((frame) => status(frame) && (state === "working" ? frame.agent_status === "working" : frame.agent_status === "done"));
    await herdrRpc("pane.report_agent", { pane_id: target.pane, source: "manual", agent: "claude", state });
    return await frame;
  };
  const write = (...entries: unknown[]) => appendFileSync(join(project, `${sessionId}.jsonl`), "\n" + entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  // Prompt association compares transcript time with observed rest: both use the injected clock.
  const now = () => new Date(statusClock).toISOString();
  const close = async () => {
    frames.socket.close();
    const removed = await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: device.subscription.endpoint }) });
    expect(removed.status).toBe(204);
    await server.alertsSettled();
    server.stop();
    device.stop();
    forgetTranscriptState();
    server = makeServer();
    await bounded(server.statusReady, "Restored status subscription");
  };
  try {
    // Resolve the native session before the status event's synchronous transcript poll.
    const tasks = await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(target.pane)}`);
    expect(tasks.status).toBe(200);
    const subscribed = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription, alerts: { input: true, done: "long" } }) });
    expect(subscribed.status).toBe(204);
    await report("working");
    statusClock += 1500;
    write({ type: "user", timestamp: now(), origin: { kind: "human" }, permissionMode: "default", message: { role: "user", content: "run the suite and ship" } },
      { type: "assistant", timestamp: now(), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${taskId}`, name: "Bash", input: { command: "bun test", description: "Run the full suite", run_in_background: true } }] } },
      { type: "user", timestamp: now(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId } });
    const held = await report("idle");
    expect(held).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    expect(await shown()).toMatchObject({ background_tasks: 1, background_wait: true });
    const alerts = () => device.received.filter((push) => push.payload.pane_id === target.pane);
    await server.alertsSettled();
    expect(alerts()).toEqual([]);
    return {
      shown, frames, status, report, alerts, close,
      alerted: () => device.waitFor((push) => push.payload.pane_id === target.pane, "Background finish", 10_000),
      end: async () => {
        const counted = frames.wait((frame) => status(frame) && frame.background_tasks === 0);
        write({ type: "queue-operation", operation: "enqueue", timestamp: now(), content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>` });
        await counted;
      },
    };
  } catch (error) { await close(); throw error; }
}

it.skipIf(!NATIVE)("holds a turn that ended on its background command, and alerts once, for the whole turn, when the turn its notice starts ends", async () => {
  const turn = await backgroundTurn("bsuite");
  try {
    await turn.end();
    expect((await turn.shown())?.background_wait).toBe(true);
    await turn.report("working");
    const alerted = turn.alerted();
    await turn.report("idle");
    await alerted;
    await server.alertsSettled();
    expect(turn.alerts().map((push) => push.payload.body)).toEqual(["work finished"]);
    expect((await turn.shown())?.background_wait).toBeUndefined();
  } finally { await turn.close(); }
}, 15_000);

it.skipIf(!NATIVE)("lets go of a turn whose work ended when no turn follows, with one frame that says so and one alert", async () => {
  const turn = await backgroundTurn("blint");
  try {
    await turn.end();
    const from = turn.frames.seen.length;
    const released = turn.frames.wait((frame) => turn.status(frame) && frame.background_wait !== true);
    const alerted = turn.alerted();
    statusClock += 1500;
    await released;
    await alerted;
    await server.alertsSettled();
    expect(turn.alerts().map((push) => push.payload.body)).toEqual(["work finished"]);
    const atRest = turn.frames.seen.slice(from).filter(turn.status);
    expect(atRest).toHaveLength(1);
    expect(atRest[0]).toMatchObject({ agent_status: "done" });
    expect(atRest[0]).not.toHaveProperty("background_wait");
    expect((await turn.shown())?.background_wait).toBeUndefined();
  } finally { await turn.close(); }
}, 15_000);
it.skipIf(!NATIVE)("reads a Claude pane's task list as its plan, and pushes its progress without a status", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const plan = async (paneId: string): Promise<PanePlan> => await (await fetch(`${base}/api/pane/plan?pane_id=${encodeURIComponent(paneId)}`)).json();
  const summary = async (paneId: string): Promise<unknown> => {
    const { snapshot } = await (await fetch(`${base}/api/session`)).json() as { snapshot: { panes: { pane_id: string; plan?: unknown }[] } };
    return snapshot.panes.find((entry) => entry.pane_id === paneId)?.plan;
  };
  const path = join(project, `${FIRST}.jsonl`);
  const call = (id: string, name: string, input: unknown, answer: unknown, content: string): string => [
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: answer },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const frames: ServerMessage[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.onmessage = (event) => { frames.push(JSON.parse(String(event.data))); };
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("no socket")); });
  try {
    // a session that made no task has no plan
    expect((await plan(first.pane)).plan).toBeNull();
    appendFileSync(path, `\n${call("toolu_p1", "TaskCreate", { subject: "Read", activeForm: "Reading" }, { task: { id: "1", subject: "Read" } }, "Task #1 created successfully: Read")}\n${call("toolu_p2", "TaskCreate", { subject: "Write" }, { task: { id: "2", subject: "Write" } }, "Task #2 created successfully: Write")}\n${call("toolu_p3", "TaskUpdate", { taskId: "2", addBlockedBy: ["1"] }, { success: true, taskId: "2", updatedFields: ["blockedBy"] }, "Updated task #2 blockedBy")}\n`);
    await until(async () => JSON.stringify(await summary(first.pane)) === JSON.stringify({ done: 0, total: 2, current: null }));
    expect((await plan(first.pane)).plan?.steps.map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}`)).toEqual(["1:pending:", "2:pending:1"]);
    appendFileSync(path, `${call("toolu_p4", "TaskUpdate", { taskId: "1", status: "in_progress" }, { success: true, taskId: "1", updatedFields: ["status"] }, "Updated task #1 status")}\n`);
    await until(async () => frames.some((frame) => frame.type === "pane-status" && frame.pane_id === first.pane && frame.plan?.current === "Reading"));
    // pushed as progress alone: the pane's status is the one it had
    expect([...frames].reverse().find((frame) => frame.type === "pane-status" && frame.pane_id === first.pane && frame.plan !== undefined)).toMatchObject({ plan: { done: 0, total: 2, current: "Reading" }, agent_status: expect.stringMatching(/^(idle|done)$/) });
  } finally {
    socket.close();
  }
});

it.skipIf(!NATIVE)("follows the current PID record without retaining a previous session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    const record = JSON.parse(previous);
    writeFileSync(path, JSON.stringify({ ...record, sessionId: NEXT }));
    const response = await read(first.pane);
    expect(response.source).toBe("claude-transcript");
    expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${NEXT}` });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("follows a /branch the PID record names while Herdr's report stays on the session it came from (#2020)", async () => {
  const BRANCH = "09512ed9-5df9-4105-954e-6597a3119b75";
  const ELSEWHERE = "6d1c2b3a-4f5e-4a7b-8c9d-0e1f2a3b4c5d";
  const branch = (id: string, from: string) => writeFileSync(join(project, `${id}.jsonl`), [
    { type: "user", message: { content: `Prompt ${from}` }, sessionId: id, forkedFrom: { sessionId: from, messageUuid: "e92def5e-231f-4b62-9766-8c9c44012d9b" } },
    { type: "assistant", message: { content: [{ type: "text", text: `Answer ${from}` }] }, sessionId: id, forkedFrom: { sessionId: from, messageUuid: "a7bd68ec-e176-4943-a826-289ef8d3d01c" } },
    { type: "user", message: { content: "Prompt after the branch" }, sessionId: id },
    { type: "assistant", message: { content: [{ type: "text", text: `Answer in ${id}` }] }, sessionId: id },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  branch(BRANCH, FIRST);
  branch(ELSEWHERE, SECOND);
  const hooked = await pane(FIRST);
  await herdrRpc("pane.report_agent_session", {
    pane_id: hooked.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST, session_start_source: "startup",
  });
  const path = join(root, ".claude", "sessions", `${hooked.pid}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  try {
    expect((await read(hooked.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
    // Claude rewrites its PID record for the branch; Herdr's report stays on FIRST
    writeFileSync(path, JSON.stringify({ ...record, sessionId: BRANCH }));
    expect((await read(hooked.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer in ${BRANCH}` });
    // a session that is no branch of the reported one keeps the report's
    writeFileSync(path, JSON.stringify({ ...record, sessionId: ELSEWHERE }));
    expect((await read(hooked.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
  } finally {
    writeFileSync(path, JSON.stringify(record));
    rmSync(join(project, `${BRANCH}.jsonl`));
    rmSync(join(project, `${ELSEWHERE}.jsonl`));
  }
});

it.skipIf(!NATIVE)("refuses a reused PID record rather than selecting another same-cwd session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(previous), procStart: "1" }));
    expect(await read(first.pane)).toEqual({ source: "scrollback", turns: [] });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("answers a session Claude has not written yet as an empty conversation, then follows the file it writes", async () => {
  const fresh = await pane(UNWRITTEN);
  const blank = await read(fresh.pane);
  expect(blank).toMatchObject({ source: "claude-transcript", turns: [], cursor: null, history_id: `unwritten:${UNWRITTEN}` });
  transcript(UNWRITTEN);
  const written = await read(fresh.pane);
  expect(written.source).toBe("claude-transcript");
  expect(written.history_id).not.toBe(`unwritten:${UNWRITTEN}`);
  expect(written.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${UNWRITTEN}` });
  rmSync(join(project, `${UNWRITTEN}.jsonl`));
  expect(await read(fresh.pane)).toEqual({ source: "scrollback", turns: [] });
});

it.skipIf(!NATIVE)("answers a session not written yet as empty while Herdr says working, as a /clear does for a moment (#2550)", async () => {
  const cleared = "c1ea7ed0-2550-4a2b-9c3d-4e5f6a7b8c9d";
  const fresh = await pane(cleared);
  await herdrRpc("pane.report_agent", { pane_id: fresh.pane, source: "manual", agent: "claude", state: "working" });
  expect(await read(fresh.pane)).toMatchObject({ source: "claude-transcript", turns: [], history_id: `unwritten:${cleared}` });
  await herdrRpc("pane.report_agent", { pane_id: fresh.pane, source: "manual", agent: "claude", state: "blocked" });
  expect(await read(fresh.pane)).toEqual({ source: "scrollback", turns: [] });
});

it.skipIf(!NATIVE)("keeps the existing Herdr hook path when no native PID record is available", async () => {
  const hooked = await pane(SECOND);
  rmSync(join(root, ".claude", "sessions", `${hooked.pid}.json`));
  await herdrRpc("pane.report_agent_session", {
    pane_id: hooked.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
  });
  const response = await read(hooked.pane);
  expect(response.source).toBe("claude-transcript");
  expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
});

it.skipIf(!NATIVE)("uses each process's config dir before the server's store, with and without a hook", async () => {
  const ownStore = join(root, "environment with spaces", ".claude");
  const serverStore = join(root, "server-store");
  // Same session id and cwd in all stores: only the process environment selects the right one.
  transcript(FIRST, ownStore, "Pane's own answer");
  transcript(FIRST, serverStore, "Server's other answer");
  const custom = await pane(FIRST, ownStore);
  process.env["CLAUDE_CONFIG_DIR"] = serverStore;
  try {
    const native = await read(custom.pane);
    expect(native.source).toBe("claude-transcript");
    expect(native.turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    rmSync(join(ownStore, "sessions", `${custom.pid}.json`));
    await herdrRpc("pane.report_agent_session", {
      pane_id: custom.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(custom.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    // A process without the variable retains the server-level fallback.
    const fallback = await pane(FIRST);
    await herdrRpc("pane.report_agent_session", {
      pane_id: fallback.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(fallback.pane)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Server's other answer" });
  } finally { delete process.env["CLAUDE_CONFIG_DIR"]; }
});

/** A `claude attach` stand-in: it tells the test its pid and runs until the pane closes. */
const ATTACH_STAND_IN = `require("node:net").connect(Number(process.env.ATTACH_READY), "127.0.0.1", function () { this.end(String(process.pid)); });
process.stdin.resume();
`;

/** A job's state with the fields Claude requires of it, made before any client in this file starts. */
function jobState(job: string, state: Record<string, unknown>): void {
  const made = "2026-01-01T00:00:00.000Z";
  mkdirSync(join(root, ".claude", "jobs", job), { recursive: true });
  writeFileSync(join(root, ".claude", "jobs", job, "state.json"), JSON.stringify({
    state: "working", detail: "", template: "bg", intent: `task of ${job}`, sessionId: `${job}-0000-4000-8000-000000000000`,
    cwd: root, createdAt: made, updatedAt: made, ...state,
  }));
}

/**
 * A pane whose foreground runs `claude <args>` with the native build's argv, and no PID record: the
 * renamed Node runs `attach` in the workspace folder as its script, so the arguments stay as typed.
 */
async function attachPane(args: readonly string[], before?: (pane: string) => Promise<void>): Promise<{ pane: string; pid: number }> {
  const created = await herdrRpc<Awaited<ReturnType<typeof workspaceCreate>>>("workspace.create", { cwd: root, label: "ovis-test-claude-attach", focus: false });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await before?.(paneId);
  writeFileSync(join(root, "attach"), ATTACH_STAND_IN);
  let ready: (pid: number) => void = () => {};
  const signal = new Promise<number>((resolve) => { ready = resolve; });
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket, data) { ready(Number(data.toString())); socket.end(); } },
  });
  const timeout = setTimeout(() => ready(0), 10_000);
  try {
    await herdrRpc("pane.send_text", {
      pane_id: paneId, text: `cd ${JSON.stringify(root)} && exec env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_SESSION_KIND ATTACH_READY=${listener.port} ${[join(root, "claude"), ...args].map((arg) => JSON.stringify(arg)).join(" ")}\n`,
    });
    const pid = await signal;
    if (!pid) throw new Error("claude attach stand-in did not signal readiness");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    return { pane: paneId, pid };
  } finally { clearTimeout(timeout); listener.stop(true); }
}

// The stand-in is the renamed Node, which takes `attach` for its script; the macOS one above is Bun.
it.skipIf(process.platform !== "linux")("follows a `claude attach <job>` pane to the job's conversation, with no start time of its own (#1645)", async () => {
  // the job's state names the session it started with and the one /clear moved it on to
  const job = "4c1d2e3f";
  const started = `${job}-0000-4000-8000-000000000001`;
  const resumed = "6e5d4c3b-2a19-4807-b6a5-948372615f0e";
  transcript(started);
  transcript(resumed);
  mkdirSync(join(root, ".claude", "jobs", job), { recursive: true });
  writeFileSync(join(root, ".claude", "jobs", job, "state.json"), JSON.stringify({ sessionId: started, resumeSessionId: resumed, state: "running" }));
  const attach = await attachPane(["attach", job]);
  // an attach client keeps no PID record of its own: only the job's state names what it shows
  expect(existsSync(join(root, ".claude", "sessions", `${attach.pid}.json`))).toBe(false);
  const conversation = await read(attach.pane);
  expect(conversation.source).toBe("claude-transcript");
  expect(conversation.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${resumed}` });
  // the job ran before the client attached: the client's start would leave the job's earlier background work lost
  expect(await claudePaneSession({ pane_id: attach.pane, cwd: root, foreground_cwd: root } as HerdrPane))
    .toEqual({ path: join(project, `${resumed}.jsonl`), startedAt: null, pid: attach.pid });
});

it.skipIf(process.platform !== "linux")("shows the attached job's conversation, not a session an earlier Claude in the pane reported (#1645)", async () => {
  const job = "7a8b9c0d";
  const shown = "1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b";
  transcript(shown);
  mkdirSync(join(root, ".claude", "jobs", job), { recursive: true });
  writeFileSync(join(root, ".claude", "jobs", job, "state.json"), JSON.stringify({ sessionId: shown, state: "running" }));
  // a reused pane: the Claude that ran here before reported its session through the hook
  const attach = await attachPane(["attach", job], async (paneId) => {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_agent_session", {
      pane_id: paneId, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
  });
  // herdr still reports that earlier session once `claude attach` is the foreground process
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: attach.pane });
  expect(info.agent.agent_session?.value).toBe(FIRST);
  const conversation = await read(attach.pane);
  expect(conversation.source).toBe("claude-transcript");
  expect(conversation.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${shown}` });
});

it.skipIf(process.platform !== "linux")("keeps the terminal of a reused pane attached to a shell-command job, which has no session (#1645)", async () => {
  const job = "5e6f7a8b";
  mkdirSync(join(root, ".claude", "jobs", job), { recursive: true });
  writeFileSync(join(root, ".claude", "jobs", job, "state.json"), JSON.stringify({ command: "sleep 100", state: "running" }));
  // the Claude that ran here before reported its session through the hook, and herdr still has it
  const attach = await attachPane(["attach", job], async (paneId) => {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_agent_session", {
      pane_id: paneId, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
  });
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: attach.pane });
  expect(info.agent.agent_session?.value).toBe(FIRST);
  // the job shows no conversation: the earlier Claude's would be another session's
  expect((await read(attach.pane)).source).toBe("scrollback");
});

it.skipIf(process.platform !== "linux")("follows a pane whose `claude` takes options before `attach` (#1645)", async () => {
  const job = "6b7c8d9e";
  const shown = "2a3b4c5d-6e7f-4809-9a1b-2c3d4e5f6a7b";
  transcript(shown);
  jobState(job, { sessionId: shown, state: "working" });
  // `-r <value>` is a root option Claude reads before `attach` (--resume), and one the renamed Node
  // takes too (--require), so the stand-in still runs `attach` with the arguments as typed
  writeFileSync(join(root, "resumed.js"), "");
  const attach = await attachPane(["-r", "./resumed.js", "attach", job]);
  const conversation = await read(attach.pane);
  expect(conversation.source).toBe("claude-transcript");
  expect(conversation.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${shown}` });
});

it.skipIf(process.platform !== "linux")("follows a pane attached by the start of a job's id or by part of its name (#1645)", async () => {
  const byId = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const byName = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
  transcript(byId);
  transcript(byName);
  jobState("3a9b8c7d", { sessionId: byId, intent: "check the build", state: "working" });
  jobState("2b3c4d5e", { sessionId: byName, name: "Contract release notes", intent: "draft the notes", state: "working" });
  const prefix = await read((await attachPane(["attach", "3a9b"])).pane);
  expect(prefix.source).toBe("claude-transcript");
  expect(prefix.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${byId}` });
  const named = await read((await attachPane(["attach", "release notes"])).pane);
  expect(named.source).toBe("claude-transcript");
  expect(named.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${byName}` });
});

it.skipIf(process.platform !== "linux")("keeps the terminal of a reused pane whose `claude attach` names no one job (#1645)", async () => {
  // both jobs start with 8e9f: Claude opens neither, and neither does the pane
  jobState("8e9f0a1b", { sessionId: SECOND, state: "working" });
  jobState("8e9f2c3d", { sessionId: NEXT, state: "working" });
  const attach = await attachPane(["attach", "8e9f"], async (paneId) => {
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await herdrRpc("pane.report_agent_session", {
      pane_id: paneId, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
  });
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: attach.pane });
  expect(info.agent.agent_session?.value).toBe(FIRST);
  // neither the earlier Claude's session, nor a guess between the two jobs
  expect((await read(attach.pane)).source).toBe("scrollback");
});
