import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError, OmoActivity, PaneBackgroundAgentDetail, ServerMessage } from "../shared/protocol.ts";
import type { BackgroundAgentDeps } from "./background-agent.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { backgroundAgentDetail, forgetSubagents } from "./claude-subagents.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { DeviceStore } from "./devices.ts";
import { herdrRpc, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-background-agent-contract-"));
const remoteHome = mkdtempSync(join(tmpdir(), "herdr-background-agent-remote-"));
const originalHome = process.env["HOME"];
const originalConfigDir = process.env["CLAUDE_CONFIG_DIR"];
const FIRST = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
const SECOND = "f2f55dc4-50ad-478c-a641-bf21268a1bba";
const WATCH_TOKEN = "test-background-agent-watch";
const REMOTE_TOKEN = "test-background-agent-remote";
/** how long a frame the test waits for may take: this PC also runs CI, and a loaded one is slow to look a session up */
const FRAME_WAIT_MS = 30_000;
const project = join(root, ".claude", "projects", claudeProjectDir(root));
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;
let remote: { process: ReturnType<typeof Bun.spawn>; port: number } | null = null;
let first: string;
let second: string;
let shell: string;
let watch: string;
let sequence = 0;
let frames: Frames;
let hold: { entered: () => void; gate: Promise<void> } | null = null;
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const base = () => `http://127.0.0.1:${server.port}`;
const detailUrl = (paneId: string, agentId: string, prefix = "/api") => `${base()}${prefix}/pane/background-agent?${new URLSearchParams({ pane_id: paneId, agent_id: agentId })}`;
const errorCode = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as ApiError).error.code];
const owner = { authorization: `Bearer ${WATCH_TOKEN}` };

function session(store: string, id: string, agentId: string, title: string, voice: string, command: boolean): void {
  mkdirSync(join(store, id, "subagents"), { recursive: true });
  writeFileSync(join(store, `${id}.jsonl`), [
    json({ type: "user", timestamp: "2026-10-06T11:00:00.000Z", message: { role: "user", content: `Prompt ${id}` } }),
    ...command ? [
      json({ type: "assistant", timestamp: "2026-10-06T11:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bsuite", name: "Bash", input: { command: "bun test", description: "Run the suite", run_in_background: true } }] } }),
      json({ type: "user", timestamp: "2026-10-06T11:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bsuite", content: "Command running in background with ID: bsuite." }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "bsuite" } }),
    ] : [],
  ].join(""));
  writeFileSync(join(store, id, "subagents", `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "reviewer", description: title, toolUseId: `toolu_${agentId}`, requestShape: "background" }));
  const own = { isSidechain: true, sessionId: id, agentId };
  writeFileSync(join(store, id, "subagents", `agent-${agentId}.jsonl`), [
    json({ ...own, type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: `${voice} dispatch for ${agentId}` } }),
    json({ ...own, type: "assistant", timestamp: new Date().toISOString(), message: { id: "m1", model: "claude-opus-5", content: [{ type: "text", text: `${voice} work on ${agentId}` }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/parser.ts" } }] } }),
  ].join(""));
}

class Frames {
  readonly seen: ServerMessage[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.seen.push(JSON.parse(String(event.data)) as ServerMessage));
  }

  static async connect(port: number, token: string): Promise<Frames> {
    // Bun's WebSocket takes headers, which the DOM type it is declared with does not know
    const frames = new Frames(new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]));
    await frames.wait((frame) => frame.type === "snapshot", 0);
    return frames;
  }

  wait(check: (frame: ServerMessage) => boolean, from: number): Promise<ServerMessage> {
    const known = this.seen.slice(from).find(check);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const receive = (event: MessageEvent): void => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (check(frame)) finish(frame);
      };
      const finish = (frame?: ServerMessage): void => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", receive);
        if (frame) resolve(frame);
        else reject(new Error(`no such frame within ${FRAME_WAIT_MS} ms: ${JSON.stringify(this.seen.slice(-4))}`));
      };
      const timer = setTimeout(() => finish(), FRAME_WAIT_MS);
      this.socket.addEventListener("message", receive);
    });
  }

  counted(paneId: string, count: number, from: number): Promise<ServerMessage> {
    return this.wait((frame) => (frame.type === "pane-status" && frame.pane_id === paneId && frame.background_tasks === count)
      || (frame.type === "snapshot" && frame.snapshot.panes.some((pane) => pane.pane_id === paneId && pane.background_tasks === count)), from);
  }
}

async function claudePane(id: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-background-agent" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "working" });
  await report(paneId, id);
  return paneId;
}

const report = (paneId: string, id: string) => herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:claude", agent: "claude", seq: ++sequence, agent_session_id: id, session_start_source: "new" });

/** the pane's Claude left and another started on `id`: herdr keeps a session until its agent's authority is cleared */
async function swap(paneId: string, id: string): Promise<void> {
  await herdrRpc("pane.clear_agent_authority", { pane_id: paneId });
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "working" });
  await report(paneId, id);
}

async function swapped(paneId: string, id: string): Promise<void> {
  const mark = frames.seen.length;
  await swap(paneId, id);
  await frames.counted(paneId, id === FIRST ? 2 : 1, mark);
}

const detail = (paneId: string, agentId: string, prefix = "/api", headers: Record<string, string> = owner): Promise<Response> => fetch(detailUrl(paneId, agentId, prefix), { headers });

async function startRemote(): Promise<{ process: ReturnType<typeof Bun.spawn>; port: number }> {
  const script = join(remoteHome, "remote-bridge.ts");
  writeFileSync(script, [
    `import { createServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
    `const server = createServer({ port: 0, hostname: "127.0.0.1", token: ${JSON.stringify(REMOTE_TOKEN)}, stateDir: ${JSON.stringify(join(remoteHome, "state"))}, machines: false, tailscaleOwner: null });`,
    "console.log(JSON.stringify({ port: server.port }));",
    "process.on(\"SIGTERM\", () => { server.stop(); process.exit(0); });",
  ].join("\n"));
  const env: Record<string, string | undefined> = { ...process.env, HOME: remoteHome };
  delete env["CLAUDE_CONFIG_DIR"];
  const child = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the remote bridge exited before it listened: ${text}`);
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((candidate) => candidate.startsWith("{"));
    if (line !== undefined) { reader.releaseLock(); return { process: child, port: (JSON.parse(line) as { port: number }).port }; }
  }
}

beforeAll(async () => {
  delete process.env["CLAUDE_CONFIG_DIR"];
  forgetTranscriptState();
  forgetSubagents();
  mkdirSync(project, { recursive: true });
  session(project, FIRST, "a1", "Review the parser", "Local", true);
  session(project, SECOND, "b1", "Write the lexer tests", "Local", false);
  session(join(remoteHome, ".claude", "projects", claudeProjectDir(root)), FIRST, "a1", "Remote review", "Remote", true);
  first = await claudePane(FIRST);
  second = await claudePane(SECOND);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-background-agent-shell" });
  workspaces.push(created.workspace.workspace_id);
  shell = created.root_pane.pane_id;
  process.env["HOME"] = root;
  const stateDir = join(root, "state");
  const devices = new DeviceStore(stateDir);
  const paired = devices.pair(devices.startPairing().code, "Watch", "watch")!;
  devices.match(paired.token);
  watch = `ovis_device=${paired.token}`;
  const read: BackgroundAgentDeps["read"] = async (path, id) => {
    const answer = backgroundAgentDetail(path, id);
    const held = hold;
    if (held !== null) { hold = null; held.entered(); await held.gate; }
    return answer;
  };
  server = createServer({ port: 0, hostname: "127.0.0.1", token: WATCH_TOKEN, stateDir, tailscaleOwner: null, backgroundAgentRead: read });
  await server.statusReady;
  frames = await Frames.connect(server.port, WATCH_TOKEN);
  await frames.counted(first, 2, 0);
  await frames.counted(second, 1, 0);
}, 90_000);

afterAll(async () => {
  frames?.socket.close();
  server?.stop();
  if (remote !== null) { remote.process.kill("SIGTERM"); await remote.process.exited; }
  forgetTranscriptState();
  forgetSubagents();
  if (originalConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
  rmSync(remoteHome, { recursive: true, force: true });
});

it("reads the selected pane's running subagent, bounded, and names no path", async () => {
  const screen = (await paneRead({ paneId: first, source: "visible", format: "text" })).text;
  const focus = (await sessionSnapshot()).focused_pane_id;
  const response = await detail(first, "a1");
  expect(response.status).toBe(200);
  const body: PaneBackgroundAgentDetail = await response.json();
  expect(body).toMatchObject({
    agent_id: "a1", session_id: FIRST, title: "Review the parser", agent: "reviewer", prompt: "Local dispatch for a1",
    events: [{ kind: "text", text: "Local work on a1" }, { kind: "tool", text: 'Read {"file_path":"src/parser.ts"}' }],
    truncated: false, incomplete: false, limits: { max_read_bytes: 256 * 1024, max_output_bytes: 128 * 1024, max_events: 128 },
  });
  expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  expect(JSON.stringify(body)).not.toContain(root);
  const activity: OmoActivity = await (await fetch(`${base()}/api/pane/omo-tasks?pane_id=${encodeURIComponent(first)}`, { headers: owner })).json();
  expect(activity.tasks.map((task) => [task.id, task.status, task.detail_kind]).sort()).toEqual([["a1", "running", "claude-subagent"], ["bsuite", "running", null]]);
  expect((await paneRead({ paneId: first, source: "visible", format: "text" })).text).toBe(screen);
  expect((await sessionSnapshot()).focused_pane_id).toBe(focus);
}, 20_000);

it("answers only the session the pane runs: another session's agent is not found, and the pane follows a session swap", async () => {
  expect(await errorCode(await detail(first, "b1"))).toEqual([404, "background_agent_not_found"]);
  expect(await errorCode(await detail(second, "a1"))).toEqual([404, "background_agent_not_found"]);
  await swapped(first, SECOND);
  const moved = await detail(first, "b1");
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as PaneBackgroundAgentDetail).session_id).toBe(SECOND);
  expect(await errorCode(await detail(first, "a1"))).toEqual([404, "background_agent_not_found"]);
  await swapped(first, FIRST);
  const restored = await detail(first, "a1");
  expect(restored.status).toBe(200);
  expect(((await restored.json()) as PaneBackgroundAgentDetail).session_id).toBe(FIRST);
}, 90_000);

it("tells a pane whose session was swapped while its read was out, and answers nothing of either session", async () => {
  let entered!: () => void;
  const out = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  hold = { entered, gate: new Promise<void>((resolve) => { release = resolve; }) };
  const answer = detail(first, "a1");
  await out;
  await swapped(first, SECOND);
  release();
  const response = await answer;
  const text = await response.text();
  expect([response.status, (JSON.parse(text) as ApiError).error.code]).toEqual([409, "background_target_changed"]);
  expect(text).not.toContain("dispatch for");
  expect(text).not.toContain("work on");
  await swapped(first, FIRST);
  expect((await detail(first, "a1")).status).toBe(200);
}, 90_000);

it("refuses what is not a subagent of a Claude pane: spelled paths, links, commands, other agents and unknown panes", async () => {
  for (const id of ["..", "a/b", "../../etc/passwd", "x".repeat(129), "a b", "/etc/passwd"]) {
    const response = await fetch(detailUrl(first, id), { headers: owner });
    expect([id, ...(await errorCode(response))]).toEqual([id, 400, "invalid_agent_id"]);
  }
  expect(await errorCode(await fetch(`${base()}/api/pane/background-agent?pane_id=${encodeURIComponent(first)}`, { headers: owner }))).toEqual([400, "missing_agent_id"]);
  expect(await errorCode(await fetch(`${base()}/api/pane/background-agent?agent_id=a1`, { headers: owner }))).toEqual([400, "missing_pane_id"]);
  expect(await errorCode(await fetch(detailUrl(first, "a1"), { method: "POST", headers: owner }))).toEqual([400, "method_not_allowed"]);
  // an agent whose files are links, to a file of this session or of another, is none of this session's
  const dir = join(project, FIRST, "subagents");
  symlinkSync(join(project, SECOND, "subagents", "agent-b1.meta.json"), join(dir, "agent-l1.meta.json"));
  symlinkSync(join(project, SECOND, "subagents", "agent-b1.jsonl"), join(dir, "agent-l1.jsonl"));
  const linked = await detail(first, "l1");
  const linkedText = await linked.text();
  expect([linked.status, (JSON.parse(linkedText) as ApiError).error.code]).toEqual([404, "background_agent_not_found"]);
  expect(linkedText).not.toContain("dispatch for b1");
  // the session's background command has a screen, not a transcript, though files bear its id; a shell pane and an unknown pane have neither
  writeFileSync(join(dir, "agent-bsuite.meta.json"), JSON.stringify({ agentType: "reviewer", description: "posing as the command" }));
  writeFileSync(join(dir, "agent-bsuite.jsonl"), json({ isSidechain: true, sessionId: FIRST, agentId: "bsuite", type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "posed dispatch" } }));
  const command = await detail(first, "bsuite");
  const commandText = await command.text();
  expect([command.status, (JSON.parse(commandText) as ApiError).error.code]).toEqual([501, "background_detail_unsupported"]);
  expect(commandText).not.toContain("posed dispatch");
  expect(await errorCode(await detail(shell, "a1"))).toEqual([501, "background_detail_unsupported"]);
  expect(await errorCode(await fetch(detailUrl("w0:p0", "a1"), { headers: owner }))).toEqual([404, "pane_not_found"]);
  expect(await errorCode(await detail(first, "nobody"))).toEqual([404, "background_agent_not_found"]);
}, 20_000);

it("lets a watching device read, and nothing more", async () => {
  const response = await detail(first, "a1", "/api", { cookie: watch });
  expect(response.status).toBe(200);
  expect(((await response.json()) as PaneBackgroundAgentDetail).prompt).toBe("Local dispatch for a1");
  expect(await errorCode(await fetch(detailUrl(first, "a1"), { method: "POST", headers: { cookie: watch, "x-herdr-machine": "1" } }))).toEqual([403, "read_only"]);
  expect((await fetch(detailUrl(first, "a1"))).status).toBe(401);
}, 20_000);

it("is forwarded to a PC's bridge, and a PC that is not there answers for no agent of this one", async () => {
  expect(MACHINE_PROXY_PATH.test("pane/background-agent")).toBe(true);
  expect(MACHINE_PROXY_PATH.test("pane/background-agent/extra")).toBe(false);
  const local = await detail(first, "a1", "/api/machines/local");
  expect(local.status).toBe(200);
  expect(((await local.json()) as PaneBackgroundAgentDetail).session_id).toBe(FIRST);
  const elsewhere = await fetch(detailUrl(first, "a1", "/api/machines/pc1"), { headers: owner });
  expect(await errorCode(elsewhere)).toEqual([503, "machine_offline"]);
}, 20_000);

it("answers each online PC from its own store, though both hold the same session and agent ids", async () => {
  remote = await startRemote();
  const remoteFrames = await Frames.connect(remote.port, REMOTE_TOKEN);
  try {
    await remoteFrames.counted(first, 2, 0);
    const endpoint = { url: `http://127.0.0.1:${remote.port}`, token: REMOTE_TOKEN };
    const manager = { endpoint: (id: string) => id === "pc2" ? endpoint : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const ask = (machine: string, agent = "a1") => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${machine}/pane/background-agent?${new URLSearchParams({ pane_id: first, agent_id: agent })}`), manager);
    const there = await ask("pc2");
    expect(there.status).toBe(200);
    const theirs: PaneBackgroundAgentDetail = await there.json();
    expect(theirs).toMatchObject({ agent_id: "a1", session_id: FIRST, title: "Remote review", prompt: "Remote dispatch for a1", events: [{ kind: "text", text: "Remote work on a1" }, { kind: "tool" }] });
    expect(JSON.stringify(theirs)).not.toContain("Local");
    expect(JSON.stringify(theirs)).not.toContain(remoteHome);
    const here = await detail(first, "a1");
    const ours: PaneBackgroundAgentDetail = await here.json();
    expect([ours.session_id, ours.prompt, JSON.stringify(ours).includes("Remote")]).toEqual([FIRST, "Local dispatch for a1", false]);
    expect(await errorCode(await ask("pc2", "b1"))).toEqual([404, "background_agent_not_found"]);
  } finally { remoteFrames.socket.close(); }
}, 120_000);
