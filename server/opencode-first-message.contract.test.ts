import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import * as herdr from "./herdr/client.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { closeOpenCodeNative } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-opencode-first-"));
const standIn = join(root, "bin", "opencode");
const SESSION = "ses_firstMessage01";
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;
let fake: ReturnType<typeof Bun.serve>;
const typedLog = (label: string) => join(root, `typed-${label}.log`);
const typed = (label: string) => existsSync(typedLog(label)) ? readFileSync(typedLog(label), "latin1") : "";

beforeAll(() => {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, ".opencode", "skills", "effect"), { recursive: true });
  writeFileSync(join(root, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect\n---\nUse Effect.\n");
  // the recorded 2.0.32 screens with their colours: @effect selected, then accepted
  const recorded = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-narrow-${name}.ansi`), "utf8").replace(/\n/g, "\r\n");
  writeFileSync(join(root, "screen.txt"), recorded("first-selected"));
  writeFileSync(join(root, "accepted.txt"), recorded("accepted"));
  writeFileSync(standIn, `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
let typed = "";
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(${JSON.stringify(root)} + "/typed-" + process.argv[2] + ".log", chunk);
  const before = typed;
  typed += chunk.toString("latin1");
  if (!before.endsWith("@effect") && typed.endsWith("@effect")) process.stdout.write("\\u001b[2J\\u001b[H" + readFileSync(${JSON.stringify(join(root, "screen.txt"))}, "utf8"));
  if (before.endsWith("@effect") && typed.endsWith("@effect\\t")) process.stdout.write("\\u001b[2J\\u001b[H" + readFileSync(${JSON.stringify(join(root, "accepted.txt"))}, "utf8"));
});
`);
  chmodSync(standIn, 0o755);
  fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [fake.url.origin], paths: { tmp: root } });
    if (url.pathname === `/api/session/${SESSION}`) return Response.json({ data: { id: SESSION } });
    const directory = url.searchParams.get("location[directory]");
    if (url.pathname === "/api/command") return Response.json({ location: { directory }, data: [] });
    if (url.pathname === "/api/skill") return Response.json({ location: { directory }, data: [{ id: "effect", name: "effect", description: "Apply Effect", path: join(root, ".opencode", "skills", "effect", "SKILL.md"), content: "Use Effect." }] });
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    return new Response("Not found", { status: 404 });
  } });
  writeFileSync(join(root, "service.json"), JSON.stringify({ url: fake.url.origin, pid: process.pid, password: "fixture-secret", version: "2.0.32" }));
  openCodeServiceOptions.stateDir = join(root, "not-this-opencode");
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), openCodeStateDir: root });
});

afterAll(async () => {
  closeOpenCodeNative();
  server?.stop();
  fake?.stop(true);
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function paneProcesses(pane: string, cwd: string): Promise<string> {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: pane }).catch((error: unknown) => ({ error: String(error) }));
  const processes = "process_info" in info ? info.process_info?.foreground_processes ?? [] : [];
  const read = (path: string): string => { try { return readFileSync(path, "utf8").trim(); } catch { return "?"; } };
  const held = (pid: number): string[] => { try { return readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return "?"; } }); } catch { return []; } };
  const config = join(cwd, "opencode.json");
  const waiting = (() => { try { return readdirSync("/proc").filter((name) => /^\d+$/.test(name)); } catch { return []; } })()
    .map(Number)
    // a process blocked opening a FIFO with no writer waits in wait_for_partner and holds no fd on it yet
    .filter((pid) => { const wchan = read(`/proc/${pid}/wchan`); return wchan === "wait_for_partner" || wchan.includes("fifo") || held(pid).includes(config); })
    .slice(0, 20)
    // any process on the machine can match: its name only, never its arguments, which may carry a secret
    .map((pid) => ({ pid, name: read(`/proc/${pid}/comm`), wchan: read(`/proc/${pid}/wchan`) }));
  const pane_processes = "error" in info ? info : processes.map(({ pid, argv }) => ({ pid, argv, wchan: pid === undefined ? null : read(`/proc/${pid}/wchan`), fds: pid === undefined ? [] : held(pid) }));
  return JSON.stringify({ pane_processes, waiting });
}

async function openCodePane(label: string, session: string | null, cwd: string, state: "working" | "idle"): Promise<string> {
  const created = await workspaceCreate({ cwd, label: `ovis-test-opencode-first-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  // herdr names the pane's agent from its foreground process: heard as it happens, not polled
  const watching = Promise.withResolvers<void>();
  const detected = Promise.withResolvers<boolean>();
  const subscription = subscribeEvents([{ type: "pane.agent_status_changed", pane_id: pane }], {
    onStarted: () => watching.resolve(),
    onEvent: (frame) => { if (frame.data?.agent === "opencode") detected.resolve(true); },
    onError: (error) => { watching.reject(error); detected.reject(error); },
    onClose: () => { watching.reject(new Error("herdr closed the agent-status subscription before acknowledging it")); detected.resolve(false); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((done) => { timer = setTimeout(() => done("expired"), 10_000); });
  try {
    if (await Promise.race([watching.promise, expired]) === "expired") throw new Error("herdr did not acknowledge the agent-status subscription");
    await herdrRpc("pane.send_text", { pane_id: pane, text: `exec ${standIn} ${label}\n` });
    if (await Promise.race([detected.promise, expired]) !== true) {
      const seen = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane);
      if (seen?.agent !== "opencode") throw new Error(`the OpenCode stand-in did not start: ${JSON.stringify(seen)} ${await paneProcesses(pane, cwd)}`);
    }
  } finally {
    clearTimeout(timer);
    subscription.close();
  }
  if (session) await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:opencode", agent: "opencode", agent_session_id: session, session_start_source: "select" });
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "herdr:opencode", agent: "opencode", ...(session ? { agent_session_id: session } : {}), state });
  return pane;
}

function connect(label: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: any[] = [];
  const waiters = new Set<{ match: (frame: any) => boolean; done: (frame: any) => void }>();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.delete(waiter); waiter.done(frame); }
  });
  const frame = (match: (frame: any) => boolean, what: string, ms = 15_000): Promise<any> => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { match, done: (found: any) => { clearTimeout(timer); resolve(found); } };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`${what}: ${JSON.stringify(typed(label))} ${JSON.stringify(frames.filter((item) => item.type === "pending-messages").slice(-2))}`)); }, ms);
      waiters.add(waiter);
    });
  };
  return { socket, frame };
}

async function firstMessage(label: string, session: string | null, cwd = root) {
  const pane = await openCodePane(label, session, cwd, "working");
  const reported = session ? { agent_session_id: session } : {};
  const { socket, frame } = connect(label);
  const { connection } = await frame((item) => item.type === "snapshot", "no snapshot");
  const message = await server.queueFirstMessage(pane, "@effect apply it", "opencode", connection);
  socket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
  await frame((item) => item.type === "input-ready" && item.pane_id === pane, "the pane's input never became ready", 10_000);
  const sent = frame((item) => item.type === "pending-messages" && item.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"), "the first message was not sent");
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "herdr:opencode", agent: "opencode", ...reported, state: "idle" });
  await sent;
  // the Enter after the message, as the stand-in records it: read its log, as fs.watch can miss the last append
  for (const deadline = Date.now() + 5_000; !typed(label).endsWith("\r");) {
    if (Date.now() > deadline) throw new Error(`no Enter after the message: ${JSON.stringify(typed(label))}`);
    await Bun.sleep(25);
  }
  const shown = await (await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json() as PanePromptResponse;
  socket.close();
  return { typed: typed(label), outcomes: shown.outcomes ?? [] };
}

it("attaches the skill through OpenCode's autocomplete when its service is verified for the pane's session, with no catalog read before", async () => {
  const sent = await firstMessage("session", SESSION);
  expect(sent.typed).toBe("@effect\t\u001b[200~apply it\u001b[201~\r");
  expect(sent.outcomes).toHaveLength(1);
  expect(sent.outcomes[0]).toMatchObject({ text: "@effect apply it" });
  expect(sent.outcomes[0]!.state).not.toBe("terminal-required");
}, 60_000);

it("retains a first queued message when Tab switches its OpenCode agent, without Enter", async () => {
  const label = "agent-change";
  const selectedPath = join(root, "screen.txt");
  const acceptedPath = join(root, "accepted.txt");
  const selected = readFileSync(selectedPath, "utf8");
  const accepted = readFileSync(acceptedPath, "utf8");
  const pane = await openCodePane(label, SESSION, root, "working");
  const { socket, frame } = connect(label);
  try {
    writeFileSync(selectedPath, selected.replace("MiniMax", "Build · MiniMax"));
    writeFileSync(acceptedPath, accepted.replace("MiniMax", "Plan · MiniMax"));
    const { connection } = await frame((item) => item.type === "snapshot", "no snapshot");
    const message = await server.queueFirstMessage(pane, "@effect apply it", "opencode", connection);
    socket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
    await frame((item) => item.type === "input-ready" && item.pane_id === pane, "the pane's input never became ready", 10_000);
    const refused = frame((item) => item.type === "pending-messages" && item.messages?.some((entry: { id: string; state: string; error?: { code: string } }) =>
      entry.id === message.id && entry.state === "uncertain" && entry.error?.code === "submit_changed"), "the first message did not retain its refusal");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "herdr:opencode", agent: "opencode", agent_session_id: SESSION, state: "idle" });
    const receipt = await refused;
    const item = receipt.messages.find((entry: { id: string }) => entry.id === message.id);
    expect(item).toMatchObject({ state: "uncertain", text: "@effect apply it", error: { code: "submit_changed" } });
    expect(item.error.message).toContain(JSON.stringify("Build"));
    expect(item.error.message).toContain(JSON.stringify("Plan"));
    expect(typed(label)).toBe("@effect\t");
    const shown = await (await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json() as PanePromptResponse;
    expect(shown.outcomes ?? []).toHaveLength(0);
  } finally {
    writeFileSync(selectedPath, selected);
    writeFileSync(acceptedPath, accepted);
    socket.close();
  }
}, 60_000);

it("answers a sender that switched to observe while its @skill was on its way with its own refusal, typing nothing", async () => {
  const label = "observe";
  const pane = await openCodePane(label, SESSION, root, "idle");
  const { socket, frame } = connect(label);
  await frame((item) => item.type === "snapshot", "no snapshot");
  socket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
  await frame((item) => item.type === "input-ready" && item.pane_id === pane, "the pane's input never became ready", 10_000);
  const originalSend = herdr.paneSendText;
  const written: string[] = [];
  // every check before the first key has passed; the sender switches to watching before herdr is written to
  const send = spyOn(herdr, "paneSendText").mockImplementation(async (paneId, text, socketPath, guard) => {
    if (paneId === pane && text === "@effect") {
      socket.send(JSON.stringify({ type: "role", mode: "observe" }));
      await frame((item) => item.type === "role-ack" && item.mode === "observe", "the role switch was not acknowledged");
    }
    await originalSend(paneId, text, socketPath, guard);
    written.push(text);
  });
  try {
    socket.send(JSON.stringify({ type: "submit", id: 1, pane_id: pane, text: "@effect apply it", payload: "@effect apply it" }));
    expect(await frame((item) => item.type === "submit-result" && item.id === 1, "no submit result")).toMatchObject({ ok: false, code: "read_only" });
    expect(written).toEqual([]);
    expect(typed(label)).toBe("");
  } finally {
    send.mockRestore();
    socket.close();
  }
}, 60_000);

it("sends a brand-new OpenCode 2's first message once as plain text, its '@' not claimed as a skill before a session vouches for the pane's version", async () => {
  const sent = await firstMessage("new", null);
  expect(sent.typed).toBe("\u001b[200~@effect apply it\u001b[201~\r");
  expect(sent.outcomes.filter((outcome) => outcome.state === "terminal-required" || outcome.note)).toEqual([]);
}, 60_000);

it("never records a v1 pane's '@' mention as a skill: the running OpenCode 2 service does not hold its session", async () => {
  const sent = await firstMessage("v1", "ses_notThisService01");
  expect(sent.typed).toBe("\u001b[200~@effect apply it\u001b[201~\r");
  expect(sent.outcomes.filter((outcome) => outcome.state === "terminal-required" || outcome.note)).toEqual([]);
}, 60_000);

it("sends a first message while the folder's opencode.json is a FIFO no one writes", async () => {
  const folder = join(root, "fifo-folder");
  mkdirSync(join(folder, ".opencode", "skills", "effect"), { recursive: true });
  writeFileSync(join(folder, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect\n---\nUse Effect.\n");
  const fifo = join(folder, "opencode.json");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  const opening = join(root, "fifo-opening");
  const writer = Bun.spawn(["sh", "-c", `sleep 30; touch '${opening}'; printf '{}' > '${fifo}'`]);
  try {
    const sent = await firstMessage("fifo", null, folder);
    expect(existsSync(opening)).toBe(false);
    expect(sent.typed).toBe("\u001b[200~@effect apply it\u001b[201~\r");
  } finally {
    writer.kill();
    rmSync(fifo, { force: true });
  }
}, 60_000);
