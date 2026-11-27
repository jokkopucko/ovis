import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneProcessInfo, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellQuote } from "./machine-security.ts";
import { processTable, tmuxCodexProcess } from "./tmux-terminal.ts";
import { testTmuxOwnAppServers } from "./tmux-own-server.test-helpers.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// A real private tmux client in the test herdr, a stand-in executable, and synthetic native files.
const linux = process.platform === "linux";
const missing = linux ? [
  !Bun.which("tmux") && "tmux", !Bun.which("node") && "node", !existsSync("/bin/ps") && "procps",
  !Bun.which("python3") && "python3", !Bun.which("ss") && "iproute2",
].filter(Boolean) : [];
const native = linux && (missing.length === 0 || Boolean(process.env.CI));
const root = mkdtempSync(join(tmpdir(), "ovis-tmux-"));
const socket = join(root, "tmux.sock");
const home = join(root, "store");
const rollout = join(home, "sessions", "rollout-2026-11-15T00-00-00-00000000-0000-4000-8000-000000000001.jsonl");
// A Codex on the shared daemon holds no rollout, even when its screen matches a stored thread.
const shownThread = "00000000-0000-4000-8000-000000000002";
const shownRollout = join(home, "sessions", `rollout-${shownThread}.jsonl`);
const shownAnswer = "This answer is visible on the tmux pane while the shared daemon holds its rollout.";
let shownWorkspace: string | undefined;
let shownPane: string;
let workspace: string | undefined;
let pane: string;
let wrappedWorkspace: string | undefined;
let wrappedPane: string;
let scriptWorkspace: string | undefined;
let scriptPane: string;
let server: ReturnType<typeof createServer> | undefined;
let tmuxStarted = false;
let rejectedWorkspace: string | undefined;
let rejectedPane: string;

async function tmux(...args: string[]): Promise<string> {
  // Exercise the actual tab-separated format under a non-UTF8 client locale.
  const child = Bun.spawn(["tmux", "-u", "-S", socket, ...args], { env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const output = new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`private tmux command failed: ${error}`);
  return await output;
}

beforeAll(async () => {
  if (!native) return;
  if (missing.length) throw new Error(`Native tmux contracts require: ${missing.join(", ")}`);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Read my native chat" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Only this native conversation belongs to the selected tmux pane." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const executable = join(root, "codex");
  symlinkSync(Bun.which("node")!, executable);
  const ready = join(root, "ready");
  const script = join(root, "holder.cjs");
  writeFileSync(script, `process.title = "codex"; require("fs").openSync(process.argv[2], "r");
    require("fs").writeFileSync(process.argv[3], String(process.pid));
    process.stdout.write("Ask Codex\\nterminal footer chrome\\n");
    process.stdin.on("data", () => process.exit(0)); process.stdin.resume();`);
  const launcher = join(root, "launcher.sh");
  // Keep both shells alive: the foreground sh waits for Codex, and the pane's bash waits for sh.
  writeFileSync(launcher, `set -m\n/bin/sh -c '"$1" "$2" "$3" "$4"; :' fixture ${[executable, script, rollout, ready].map(shellQuote).join(" ")}\n`);
  const watcher = watch(root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((done, fail) => {
    watcher.on("change", (_, file) => { if (file === "ready" && existsSync(ready)) done(); });
    timer = setTimeout(() => fail(new Error("stand-in did not open its rollout")), 5000);
  });
  try {
    tmuxStarted = true;
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(launcher)}`);
    await started;
  } finally { watcher.close(); clearTimeout(timer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S attached");
  const attached = Bun.spawn(["tmux", "-S", socket, "wait-for", "attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-native-chat" });
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t fixture\n` });
  if (await attached.exited !== 0) throw new Error("private tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle" });
  const outerChild = join(root, "outer-child.sh");
  const outerRoot = join(root, "outer-root.sh");
  writeFileSync(outerChild, `tmux -S ${shellQuote(socket)} attach-session -E -t fixture; :\n`);
  writeFileSync(outerRoot, `/bin/sh ${shellQuote(outerChild)}; :\n`);
  await tmux("set-hook", "-g", "client-attached", "wait-for -S wrapped-attached");
  const wrappedAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "wrapped-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const wrapped = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-outer-shells" });
  wrappedWorkspace = wrapped.workspace.workspace_id;
  wrappedPane = wrapped.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: wrappedPane, text: `exec env -u TMUX -u BASH_ENV -u ENV /bin/sh ${shellQuote(outerRoot)}\n` });
  if (await wrappedAttached.exited !== 0) throw new Error("private wrapped tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: wrappedPane, source: "manual", agent: "codex", state: "idle" });
  const scriptDir = join(root, "script");
  mkdirSync(scriptDir);
  const scriptHolder = join(scriptDir, "codex.js");
  writeFileSync(scriptHolder, `require("fs").openSync(process.argv[2], "r");
    require("fs").writeFileSync(process.argv[3], String(process.pid));
    process.stdout.write("Ask Codex\\nterminal footer chrome\\n"); process.stdin.resume();`);
  const scriptReady = join(root, "script-ready");
  const scriptLauncher = join(root, "script-launcher.sh");
  writeFileSync(scriptLauncher, `set -m\n${[Bun.which("node")!, "--no-warnings", scriptHolder, rollout, scriptReady, ""].map(shellQuote).join(" ")}\n`);
  const scriptWatcher = watch(root);
  let scriptTimer: ReturnType<typeof setTimeout> | undefined;
  const scriptStarted = new Promise<void>((done, fail) => {
    scriptWatcher.on("change", (_, file) => { if (file === "script-ready" && existsSync(scriptReady)) done(); });
    scriptTimer = setTimeout(() => fail(new Error("script holder did not open its rollout")), 5000);
  });
  try {
    await tmux("new-session", "-d", "-s", "script", `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(scriptLauncher)}`);
    await scriptStarted;
  } finally { scriptWatcher.close(); clearTimeout(scriptTimer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S script-attached");
  const scriptAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "script-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const scriptView = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-script" });
  scriptWorkspace = scriptView.workspace.workspace_id;
  scriptPane = scriptView.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: scriptPane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t script\n` });
  if (await scriptAttached.exited !== 0) throw new Error("private script tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: scriptPane, source: "manual", agent: "codex", state: "idle" });
  writeFileSync(shownRollout, [
    { type: "session_meta", payload: { id: shownThread, cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Read the daemon chat" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: shownAnswer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(shownThread, shownRollout, root);
  db.close();
  const shower = join(root, "shower.cjs");
  const shownReady = join(root, "shown-ready");
  writeFileSync(shower, `process.title = "codex"; process.stdout.write(${JSON.stringify(`>_ OpenAI Codex (v0.167.0)\n\n${shownAnswer}\n`)});
    require("fs").writeFileSync(process.argv[2], String(process.pid)); process.stdin.resume();`);
  const shownLauncher = join(root, "shown-launcher.sh");
  writeFileSync(shownLauncher, `set -m\n${[executable, shower, shownReady].map(shellQuote).join(" ")}\n`);
  const shownWatcher = watch(root);
  let shownTimer: ReturnType<typeof setTimeout> | undefined;
  const shownStarted = new Promise<void>((done, fail) => {
    shownWatcher.on("change", (_, file) => { if (file === "shown-ready" && existsSync(shownReady)) done(); });
    shownTimer = setTimeout(() => fail(new Error("screen-only stand-in did not start")), 5000);
  });
  try {
    await tmux("new-session", "-d", "-s", "shown", "-x", "200", "-y", "50", "-c", root, `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(shownLauncher)}`);
    await shownStarted;
  } finally { shownWatcher.close(); clearTimeout(shownTimer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S shown-attached");
  const shownAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "shown-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const shownView = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-screen-only" });
  shownWorkspace = shownView.workspace.workspace_id;
  shownPane = shownView.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: shownPane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t shown\n` });
  if (await shownAttached.exited !== 0) throw new Error("private screen-only tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: shownPane, source: "manual", agent: "codex", state: "idle" });
  // A real readable non-Codex argv with comm=codex and an owned held FD must not be promoted.
  const rejectedReady = join(root, "rejected-ready");
  const rejectedScript = join(root, "not-codex.py");
  writeFileSync(rejectedScript, `import ctypes, os, sys
assert ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0) == 0
held = open(${JSON.stringify(rollout)}, "r")
print("Ask Codex; synthetic terminal chrome", flush=True)
open(${JSON.stringify(rejectedReady)}, "w").write(str(os.getpid()))
sys.stdin.read()
`);
  const rejectedLauncher = join(root, "rejected-launcher.sh");
  writeFileSync(rejectedLauncher, `set -m\n${[Bun.which("python3")!, rejectedScript].map(shellQuote).join(" ")}\n`);
  const rejectedWatcher = watch(root);
  let rejectedTimer: ReturnType<typeof setTimeout> | undefined;
  const rejectedStarted = new Promise<void>((done, fail) => {
    rejectedWatcher.on("change", (_, file) => { if (file === "rejected-ready" && existsSync(rejectedReady)) done(); });
    rejectedTimer = setTimeout(() => fail(new Error("rejected argv stand-in did not start")), 5000);
  });
  try {
    await tmux("new-session", "-d", "-s", "rejected", `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(rejectedLauncher)}`);
    await rejectedStarted;
  } finally { rejectedWatcher.close(); clearTimeout(rejectedTimer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S rejected-attached");
  const rejectedAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "rejected-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const rejectedView = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-rejected-argv" });
  rejectedWorkspace = rejectedView.workspace.workspace_id; rejectedPane = rejectedView.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: rejectedPane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t rejected\n` });
  if (await rejectedAttached.exited !== 0) throw new Error("rejected argv tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: rejectedPane, source: "manual", agent: "codex", state: "idle" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "app"), codexHome: home });
}, 15_000);

async function cleanup(steps: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Private tmux fixture cleanup failed");
}

afterAll(() => cleanup([
  () => server?.stop(),
  () => workspace ? workspaceClose(workspace) : undefined,
  () => wrappedWorkspace ? workspaceClose(wrappedWorkspace) : undefined,
  () => scriptWorkspace ? workspaceClose(scriptWorkspace) : undefined,
  () => shownWorkspace ? workspaceClose(shownWorkspace) : undefined,
  () => rejectedWorkspace ? workspaceClose(rejectedWorkspace) : undefined,
  () => tmuxStarted ? tmux("kill-server") : undefined,
  () => rmSync(root, { recursive: true, force: true }),
]));

it.skipIf(!native)("keeps scrollback for a shared-daemon TUI even when its screen matches a stored thread", async () => {
  const pid = Number(readFileSync(join(root, "shown-ready"), "utf8"));
  expect(readdirSync(`/proc/${pid}/fd`).some((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`).endsWith(".jsonl"))).toBe(false);
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(shownPane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("scrollback");
  expect(JSON.stringify(conversation)).not.toContain("Read the daemon chat");
});

testTmuxOwnAppServers({ enabled: native, root, socket, home, rollout, tmux, port: () => server?.port });

it.skipIf(!native)("serves native turns behind a foreground shell launcher instead of its tmux terminal chrome", async () => {
  const pid = Number(readFileSync(join(root, "ready"), "utf8"));
  const rows = await processTable();
  const codex = rows.find((row) => row.pid === pid)!;
  const launcher = rows.find((row) => row.pid === codex.parent)!;
  const rootPid = Number((await tmux("display-message", "-p", "-t", "fixture", "#{pane_pid}")).trim());
  expect(launcher.command).toMatch(/(?:^|\/)sh$/);
  expect(launcher.pid).not.toBe(rootPid);
  expect(launcher.parent).toBe(rootPid);
  expect(codex.group).toBe(launcher.group);
  expect(codex.foreground).toBe(launcher.group);
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(conversation.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("serves the held native conversation through two live outer shell ancestors", async () => {
  const info = (await paneProcessInfo(wrappedPane))!;
  const rows = await processTable();
  const outer = rows.filter((row) => info.foreground_processes!.some((process) => process.pid === row.pid));
  expect(outer).toHaveLength(3);
  expect(outer.filter((row) => /(?:^|\/)sh$/.test(row.command))).toHaveLength(2);
  const client = outer.find((row) => /tmux/.test(row.command))!;
  const parent = outer.find((row) => row.pid === client.parent)!;
  expect(parent.parent).toBe(info.shell_pid!);
  expect(outer.every((row) => row.group === client.foreground && row.foreground === client.foreground)).toBe(true);
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(wrappedPane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("reads node codex.js argv and its held rollout without a renamed process title", async () => {
  const pid = Number(readFileSync(join(root, "script-ready"), "utf8"));
  expect(basename(readlinkSync(`/proc/${pid}/exe`))).toBe("node");
  expect((await processTable()).find((row) => row.pid === pid)!.command).not.toMatch(/codex/);
  const found = await tmuxCodexProcess(await paneProcessInfo(scriptPane));
  expect(found?.pid).toBe(pid);
  expect(found!.argv).toContain(join(root, "script", "codex.js"));
  expect(found!.argv.at(-1)).toBe("");
  expect(found!.identity).not.toContain(join(root, "script", "codex.js"));
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(scriptPane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("drops native chat for a dead retained pane even while tmux retains its PID and tty", async () => {
  const format = "#{pane_dead}\t#{pane_pid}\t#{pane_tty}";
  const before = (await tmux("display-message", "-p", "-t", "fixture", format)).trim().split("\t");
  expect(before[0]).toBe("0");
  await tmux("set-option", "-w", "-t", "fixture", "remain-on-exit", "on");
  await tmux("set-hook", "-g", "pane-died", "wait-for -S ended");
  const ended = Bun.spawn(["tmux", "-S", socket, "wait-for", "ended"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  await tmux("send-keys", "-t", "fixture", "x", "Enter");
  expect(await ended.exited).toBe(0);
  const after = (await tmux("display-message", "-p", "-t", "fixture", format)).trim().split("\t");
  expect(after[0]).toBe("1");
  expect(after.slice(1)).toEqual(before.slice(1));
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  expect((await response.json() as ConversationResponse).source).toBe("scrollback");
});


it.skipIf(!native)("does not serve a local conversation from readable rejected argv plus one real held rollout", async () => {
  const pid = Number(readFileSync(join(root, "rejected-ready"), "utf8"));
  expect((await processTable()).find((row) => row.pid === pid)!.command).toBe("codex");
  expect(readdirSync(`/proc/${pid}/fd`).some((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`) === rollout)).toBe(true);
  const attached = await tmuxCodexProcess(await paneProcessInfo(rejectedPane));
  expect(attached).toMatchObject({ pid, argvRead: true, argvState: "rejected" });
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(rejectedPane)}`);
  expect(response.status).toBe(200);
  const answer = await response.json() as ConversationResponse;
  expect(answer.source).toBe("scrollback");
  expect(JSON.stringify(answer)).not.toContain("Only this native conversation belongs");
});
