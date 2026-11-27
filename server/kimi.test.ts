import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { forgetTranscriptState, MAX_PAGE_PROMPTS, TRANSCRIPT_WINDOW_BYTES, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import * as herdr from "./herdr/client.ts";
import { kimiTranscriptForPane, kimiTranscriptPathForPane, kimiWireForPane, kimiWireForWindowsProcesses, parseKimiTranscript } from "./kimi.ts";
import { processStartedAt } from "./process-start.ts";
import * as windowsProcesses from "./windows-processes.ts";
import { tryWindowsProcessTable, windowsTableWatermark, type ProcessRow } from "./windows-processes.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { TOOL_OUTPUT_CHARS } from "./tool-output.ts";
import { turnStarts } from "./transcript-turns.ts";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); forgetTranscriptState(); });
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function kimiHome(...sessions: string[]): { home: string; wire: (id: string) => string; lock: (id: string, body: unknown) => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kimi-home-"))); roots.push(home);
  const wire = (id: string) => join(home, ".kimi-code", "sessions", "wd_work_0123456789ab", id, "agents", "main", "wire.jsonl");
  for (const id of sessions) { mkdirSync(join(wire(id), ".."), { recursive: true }); writeFileSync(wire(id), ""); }
  const locks = join(home, ".kimi-code", "locks", "sessions");
  mkdirSync(locks, { recursive: true });
  return { home, wire, lock: (id, body) => writeFileSync(join(locks, `${id}.lock`), typeof body === "string" ? body : JSON.stringify(body)) };
}
const TEST_PROCESS_START = 1_000;
const testProcessIdentity = process.platform === "linux" || process.platform === "darwin" ? undefined : {
  startUpperBound: (pid: number) => pid === process.pid ? TEST_PROCESS_START : null,
  program: (pid: number) => pid === process.pid ? String(TEST_PROCESS_START) : null,
};
const kimiWireForTestPane = (paneId: string, pids: number[], home: string) => kimiWireForPane(paneId, pids, home, testProcessIdentity);
let panes = 0;
const kimiWireForProcesses = (pids: number[], home: string) => kimiWireForTestPane(`w1:p${++panes}`, pids, home);
const liveLock = (pid = process.pid) => ({ version: 1, token: `${pid}:x`, pid, hostname: hostname(), startedAt: Date.now(), clientIdentity: "kimi_code_cli" });

const WIRE = [
  { type: "metadata", protocol_version: "1.5", created_at: 1793439028458 },
  { type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "Sag Hallo" }] } },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "think", think: "ueberlege" } }, time: 1793439030000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Hallo!" } }, time: 1793439031000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "tool_1", name: "Bash", args: { command: "echo hi" }, display: { kind: "command", command: "echo hi" } }, time: 1793439032000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "tool_1", result: { output: "hi\n" } }, time: 1793439033000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "tool_2", name: "Read", args: { path: "/x" } }, time: 1793439034000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "tool_2", result: { output: "kaputt", isError: true } }, time: 1793439035000 },
  { type: "context.append_message", agentId: "main", message: { role: "user", content: "Und Tschau" } },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Tschau!" } }, time: 1793439036000 },
].map((record) => JSON.stringify(record)).join("\n");

it("parses wire.jsonl into user and assistant turns", () => {
  const turns = parseKimiTranscript(WIRE);
  expect(turns).toHaveLength(4);

  expect(turns[0]!.role).toBe("user");
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Sag Hallo" }]);

  const answer = turns[1]!;
  expect(answer.role).toBe("assistant");
  expect(answer.ts).toBe(new Date(1793439030000).toISOString());
  expect(answer.parts[0]).toEqual({ kind: "thinking", text: "ueberlege" });

  const bash = answer.parts.find((part) => part.kind === "tool" && part.name === "Bash");
  expect(bash).toMatchObject({ kind: "tool", summary: "echo hi", input: JSON.stringify({ command: "echo hi" }), output: "hi\n", state: "ok", call_id: "tool_1" });

  const read = answer.parts.find((part) => part.kind === "tool" && part.name === "Read");
  expect(read).toMatchObject({ kind: "tool", summary: "Read", output: "kaputt", state: "error", error: true });

  expect(turns[2]!.role).toBe("user");
  expect(turns[2]!.parts).toEqual([{ kind: "text", text: "Und Tschau" }]);
  expect(turns[3]!.role).toBe("assistant");
  expect(turns[3]!.parts).toEqual([{ kind: "text", text: "Tschau!" }]);
});

it("serves no tool output from another wire log that a folder swap puts at the path around the lookup's open", () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-swap-")); roots.push(root);
  const folder = join(root, "main");
  const elsewhere = join(root, "elsewhere");
  const away = join(root, "away");
  mkdirSync(folder);
  mkdirSync(elsewhere);
  const path = join(folder, "wire.jsonl");
  writeFileSync(path, WIRE);
  writeFileSync(join(elsewhere, "wire.jsonl"), WIRE.replace('"kaputt"', '"FRGNDT"'));
  expect(transcriptToolOutput("kimi-transcript", path, "tool_2")).toBe("kaputt");
  // the path names the pane's own log when the lookup begins; its open meets the other folder
  let swaps = 0;
  const real = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] !== path) return real(...args);
    swaps++;
    renameSync(folder, away);
    renameSync(elsewhere, folder);
    try { return real(...args); }
    finally {
      renameSync(folder, elsewhere);
      renameSync(away, folder);
    }
  }) as typeof fs.openSync);
  let answered: string | null;
  try { answered = transcriptToolOutput("kimi-transcript", path, "tool_2"); } finally { spy.mockRestore(); }
  expect(swaps).toBeGreaterThan(0);
  expect(answered).toBeNull();
});

it("leaves a tool call pending when no result followed it", () => {
  const wire = [
    { type: "context.append_message", message: { role: "user", content: "x" } },
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_9", name: "Bash", args: { command: "sleep 9" } } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", state: "pending", output: "" });
});

it("skips broken lines without losing the turn structure", () => {
  const turns = parseKimiTranscript(`{not json}\n${JSON.stringify({ type: "context.append_message", message: { role: "user", content: "hi" } })}\n`);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "hi" }]);
});

it("drops meta traffic: only the user's own input becomes a turn", () => {
  const wire = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "injection", variant: "system_reminder" }, content: [{ type: "text", text: "<system-reminder>The date has changed</system-reminder>" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "injection", variant: "agents_md" }, content: [{ type: "text", text: "# AGENTS.md" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "task", taskId: "bash-1", status: "completed" }, content: [{ type: "text", text: "<notification id=\"task:bash-1:completed\">" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "cron_job", jobId: "j1" }, content: [{ type: "text", text: "<cron-fire jobId=\"j1\">" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "skill_activation" }, content: [{ type: "text", text: "skill" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "Echte Frage" }] } },
    { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Antwort" } }, time: 1793439036000 },
  ].map((record) => JSON.stringify(record)).join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toEqual({ role: "user", ts: null, parts: [{ kind: "text", text: "Echte Frage" }] });
  expect(turns[1]!.role).toBe("assistant");
  expect(turnStarts(Buffer.from(wire), "kimi-transcript")).toHaveLength(1);
});

it("marks user prompts as turn starts for the transcript scanner", () => {
  const bytes = Buffer.from(WIRE);
  const starts = turnStarts(bytes, "kimi-transcript");
  expect(starts).toHaveLength(2);
  expect(bytes.subarray(starts[0]!).toString("utf8")).toContain("Sag Hallo");
  expect(bytes.subarray(starts[1]!).toString("utf8")).toContain("Und Tschau");
});

it("binds the session a live lock of the pane's own process names, and follows a new one at once", () => {
  const { home, wire, lock } = kimiHome("session_a", "session_b");
  lock("session_a", liveLock());
  expect(kimiWireForProcesses([process.pid], home)).toBe(wire("session_a"));
  // another pane's process: no binding
  expect(kimiWireForProcesses([process.pid + 1_000_000], home)).toBeNull();
  // /new in the pane: the CLI lets go of A and takes B
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  lock("session_b", liveLock());
  expect(kimiWireForProcesses([process.pid], home)).toBe(wire("session_b"));
});

it("finds a locked session in a managed workspace's store too", () => {
  const { home, lock } = kimiHome();
  const path = join(home, ".kimi-code", "sessions", "wm_6f1c2d3e-0000-4000-8000-000000000000", "session_w", "agents", "main", "wire.jsonl");
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "");
  lock("session_w", liveLock());
  expect(kimiWireForProcesses([process.pid], home)).toBe(path);
});

const SHELL_PID = process.pid === 10_000 ? 10_001 : 10_000;

function windowsKimiRows(pid = process.pid, started = Date.now() - 10_000): ProcessRow[] {
  return [
    { pid: SHELL_PID, parent: 0, path: "C:\\Windows\\PowerShell\\powershell.exe", commandLine: "powershell.exe", started: started - 1_000 },
    { pid, parent: SHELL_PID, path: "C:\\Tools\\kimi.exe", commandLine: "kimi.exe", started },
  ];
}

it("binds a Windows pane's Kimi descendant and keeps its session while that process is idle", () => {
  const { home, wire, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  const started = rows[1]!.started!;
  lock("session_a", { ...liveLock(), startedAt: started + 1 });
  expect(kimiWireForWindowsProcesses("win:p1", SHELL_PID, rows, home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  expect(kimiWireForWindowsProcesses("win:p1", SHELL_PID, rows, home)).toBe(wire("session_a"));
});

it("refuses a Windows lock from before the process started and a pane without Kimi", () => {
  const { home, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  lock("session_a", { ...liveLock(), startedAt: rows[1]!.started! - 1 });
  expect(kimiWireForWindowsProcesses("win:p2", SHELL_PID, rows, home)).toBeNull();
  expect(kimiWireForWindowsProcesses("win:p3", SHELL_PID, [rows[0]!], home)).toBeNull();
});

it("excludes a Windows Kimi launched in a separate console (own conhost.exe or OpenConsole.exe child)", () => {
  const { home, lock } = kimiHome("session_sep");
  const started = Date.now() - 10_000;
  const hostPid = [SHELL_PID + 50, SHELL_PID + 51].find((pid) => pid !== process.pid)!;
  lock("session_sep", { ...liveLock(process.pid), startedAt: started + 10 });
  const cases: { path: string | null; commandLine: string | null }[] = [
    { path: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe 0x4" },
    { path: null, commandLine: "\\??\\C:\\Windows\\System32\\conhost.exe 0x4" },
    { path: null, commandLine: "\"C:\\Windows\\System32\\conhost.exe\" 0x4" },
    { path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\OpenConsole.exe", commandLine: "OpenConsole.exe --headless" },
    { path: null, commandLine: "\"C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\OpenConsole.exe\" --headless" },
  ];
  for (const [index, host] of cases.entries()) {
    const rows: ProcessRow[] = [
      { pid: SHELL_PID, parent: 0, path: "C:\\Windows\\PowerShell\\powershell.exe", commandLine: "powershell.exe", started: started - 2_000 },
      { pid: process.pid, parent: SHELL_PID, path: "C:\\Tools\\kimi.exe", commandLine: "kimi.exe", started },
      { pid: hostPid, parent: process.pid, path: host.path, commandLine: host.commandLine, started: started + 5 },
    ];
    expect(kimiWireForWindowsProcesses(`win:sep-console-${index}`, SHELL_PID, rows, home)).toBeNull();
  }
  // A child whose arguments mention conhost.exe is not a console host and must not exclude Kimi.
  const argChildRows: ProcessRow[] = [
    { pid: SHELL_PID, parent: 0, path: "C:\\Windows\\PowerShell\\powershell.exe", commandLine: "powershell.exe", started: started - 2_000 },
    { pid: process.pid, parent: SHELL_PID, path: "C:\\Tools\\kimi.exe", commandLine: "kimi.exe", started },
    { pid: hostPid, parent: process.pid, path: null, commandLine: "cmd.exe /c echo C:\\Windows\\System32\\conhost.exe", started: started + 5 },
  ];
  expect(kimiWireForWindowsProcesses("win:arg-conhost", SHELL_PID, argChildRows, home)).toContain("session_sep");
});

it("withholds but preserves an idle Windows Kimi binding when a snapshot omits start time or executable metadata", () => {
  const { home, wire, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  const started = rows[1]!.started!;
  lock("session_a", { ...liveLock(), startedAt: started + 1 });
  expect(kimiWireForWindowsProcesses("win:missing-start", SHELL_PID, rows, home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  const missingStart: ProcessRow[] = [rows[0]!, { pid: rows[1]!.pid, parent: rows[1]!.parent, path: rows[1]!.path, commandLine: rows[1]!.commandLine }];
  expect(kimiWireForWindowsProcesses("win:missing-start", SHELL_PID, missingStart, home)).toBeNull();
  expect(kimiWireForWindowsProcesses("win:missing-start", SHELL_PID, rows, home)).toBe(wire("session_a"));
  const missingExec: ProcessRow[] = [rows[0]!, { pid: rows[1]!.pid, parent: rows[1]!.parent, path: null, commandLine: null, started }];
  expect(kimiWireForWindowsProcesses("win:missing-start", SHELL_PID, missingExec, home)).toBeNull();
  expect(kimiWireForWindowsProcesses("win:missing-start", SHELL_PID, rows, home)).toBe(wire("session_a"));
  // Script-run Kimi (`node.exe kimi.js`) with null commandLine keeps its idle binding too.
  const nodeRows: ProcessRow[] = [
    rows[0]!,
    { pid: process.pid, parent: SHELL_PID, path: "C:\\Program Files\\nodejs\\node.exe", commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Tools\\kimi.js", started },
  ];
  lock("session_a", { ...liveLock(), startedAt: started + 1 });
  expect(kimiWireForWindowsProcesses("win:node-missing-cmd", SHELL_PID, nodeRows, home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  const missingNodeCmd: ProcessRow[] = [rows[0]!, { pid: process.pid, parent: SHELL_PID, path: "C:\\Program Files\\nodejs\\node.exe", commandLine: null, started }];
  expect(kimiWireForWindowsProcesses("win:node-missing-cmd", SHELL_PID, missingNodeCmd, home)).toBeNull();
  expect(kimiWireForWindowsProcesses("win:node-missing-cmd", SHELL_PID, nodeRows, home)).toBe(wire("session_a"));
});

it("distinguishes an unavailable Windows process table from a successful empty one", async () => {
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "console.log('[]')"])).toEqual([]);
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "console.log('not json')"])).toBeNull();
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "console.log('null')"])).toBeNull();
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "console.log('{}')"])).toBeNull();
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "console.log('[{}]')"])).toBeNull();
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", ""])).toBeNull();
  expect(await tryWindowsProcessTable(1_000, [process.execPath, "-e", "process.exit(1)"])).toBeNull();
});

it("keeps an idle Windows Kimi binding through an unavailable process table", () => {
  const { home, wire, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  const started = rows[1]!.started!;
  lock("session_a", { ...liveLock(), startedAt: started + 1 });
  expect(kimiWireForWindowsProcesses("win:probe", SHELL_PID, rows, home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  expect(kimiWireForWindowsProcesses("win:probe", SHELL_PID, rows, home)).toBe(wire("session_a"));
  expect(kimiWireForWindowsProcesses("win:probe", SHELL_PID, null, home)).toBeNull();
  expect(kimiWireForWindowsProcesses("win:probe", SHELL_PID, rows, home)).toBe(wire("session_a"));
});

it("reads a Windows pane's Kimi below the shell herdr names, and keeps it while the process table cannot be read", async () => {
  const { home, wire, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  lock("session_a", { ...liveLock(), startedAt: rows[1]!.started! + 1 });
  let table: ProcessRow[] | null = rows;
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "win:route", shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID, name: "powershell.exe", argv: ["powershell.exe"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const probe = spyOn(windowsProcesses, "tryWindowsProcessTable").mockImplementation(async () => table);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const pane = { pane_id: "win:route" } as HerdrPane;
    expect(await kimiTranscriptPathForPane(pane, home)).toBe(wire("session_a"));
    rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
    table = null;
    expect(await kimiTranscriptPathForPane(pane, home)).toBeNull();
    table = rows;
    expect(await kimiTranscriptPathForPane(pane, home)).toBe(wire("session_a"));
    expect(probe).toHaveBeenCalledTimes(3);
  } finally {
    Object.defineProperty(process, "platform", platform);
    info.mockRestore();
    probe.mockRestore();
  }
});

it("coalesces concurrent Windows process table probes instead of spawning one per pane", async () => {
  const { home, wire, lock } = kimiHome("session_a");
  const rows = windowsKimiRows();
  lock("session_a", { ...liveLock(), startedAt: rows[1]!.started! + 1 });
  let release!: (value: ProcessRow[] | null) => void;
  const pending = new Promise<ProcessRow[] | null>((resolve) => { release = resolve; });
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => ({ pane_id: paneId, shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID, name: "powershell.exe", argv: ["powershell.exe"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const probe = spyOn(windowsProcesses, "tryWindowsProcessTable").mockImplementation(() => pending);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const calls = [1, 2, 3, 4].map((n) => kimiTranscriptPathForPane({ pane_id: `win:conc-${n}` } as HerdrPane, home));
    await Promise.resolve();
    await Promise.resolve();
    release(rows);
    const results = await Promise.all(calls);
    expect(results).toEqual([wire("session_a"), wire("session_a"), wire("session_a"), wire("session_a")]);
    expect(probe).toHaveBeenCalledTimes(1);

    // Discovery (fresh: false) reuses the recent snapshot populated by the probe above without spawning another PowerShell.
    expect(await kimiTranscriptPathForPane({ pane_id: "win:conc-1" } as HerdrPane, home, { fresh: false })).toBe(wire("session_a"));
    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, "platform", platform);
    info.mockRestore();
    probe.mockRestore();
  }
});

it("shares the recent Windows table with OmO/GJC, retries a cached discovery miss, and honors the freshAfter watermark", async () => {
  const { home, wire, lock } = kimiHome("session_a");
  const shellOnly: ProcessRow[] = [{ pid: SHELL_PID, parent: 0, path: "C:\\Windows\\PowerShell\\powershell.exe", commandLine: "powershell.exe", started: Date.now() - 20_000 }];
  const started1 = Date.now() - 10_000;
  const rows1 = windowsKimiRows(process.pid, started1);
  const rows2 = windowsKimiRows(process.pid, started1 + 500);
  let table: ProcessRow[] = shellOnly;
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => ({ pane_id: paneId, shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID, name: "powershell.exe", argv: ["powershell.exe"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const probe = spyOn(windowsProcesses, "tryWindowsProcessTable").mockImplementation(async () => table);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    // 1. Prime the shared recent snapshot via recentProcessTable (as OmO/GJC detection does) before Kimi starts.
    expect(await recentProcessTable()).toEqual(shellOnly);
    expect(probe).toHaveBeenCalledTimes(1);

    // 2. Kimi starts and takes a lock while the 5s cache is warm; cached miss retries fresh and finds Kimi immediately.
    table = rows1;
    lock("session_a", { ...liveLock(), startedAt: started1 + 1 });
    const first = await kimiTranscriptForPane({ pane_id: "win:shared" } as HerdrPane, home, { fresh: false });
    expect(first).toEqual({ path: wire("session_a"), owner: `${process.pid}:${started1}` });
    expect(probe).toHaveBeenCalledTimes(2);

    // 3. Another pane reading discovery hits the warm shared cache without another probe.
    expect(await kimiTranscriptForPane({ pane_id: "win:shared-2" } as HerdrPane, home, { fresh: false })).toEqual({ path: wire("session_a"), owner: `${process.pid}:${started1}` });
    expect(probe).toHaveBeenCalledTimes(2);

    // 4. Watermark prevents a final verification check from joining an older in-flight probe, and owner detects changed start time.
    let releaseOld!: (value: ProcessRow[] | null) => void;
    const oldProbe = new Promise<ProcessRow[] | null>((resolve) => { releaseOld = resolve; });
    let call = 0;
    probe.mockImplementation(() => {
      call++;
      return call === 1 ? oldProbe : Promise.resolve(rows2);
    });
    lock("session_a", { ...liveLock(), startedAt: started1 + 501 });
    const older = kimiTranscriptForPane({ pane_id: "win:older" } as HerdrPane, home, { fresh: true });
    await Promise.resolve();
    await Promise.resolve();
    const watermark = windowsTableWatermark();
    const newer = await kimiTranscriptForPane({ pane_id: "win:shared" } as HerdrPane, home, { fresh: true, freshAfter: watermark });
    expect(newer).toEqual({ path: wire("session_a"), owner: `${process.pid}:${started1 + 500}` });
    expect(newer?.owner).not.toBe(first?.owner);
    releaseOld(rows1);
    await older;
    expect(call).toBe(2);

    // 5. An out-of-order older shell-only probe finishing late must not overwrite a newer snapshot or drop an idle binding.
    let releaseStale!: (value: ProcessRow[] | null) => void;
    const staleProbe = new Promise<ProcessRow[] | null>((resolve) => { releaseStale = resolve; });
    probe.mockImplementationOnce(() => staleProbe).mockResolvedValue(rows2);
    const staleReq = kimiTranscriptForPane({ pane_id: "win:unrelated" } as HerdrPane, home, { fresh: true });
    await Promise.resolve();
    await Promise.resolve();
    const wm2 = windowsTableWatermark();
    expect(await kimiTranscriptForPane({ pane_id: "win:oo-race" } as HerdrPane, home, { fresh: true, freshAfter: wm2 })).toEqual({ path: wire("session_a"), owner: `${process.pid}:${started1 + 500}` });
    rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
    releaseStale(shellOnly);
    expect(await staleReq).toBeNull();
    // Next discovery poll still sees the newer snapshot and preserves the idle binding.
    expect(await kimiTranscriptForPane({ pane_id: "win:oo-race" } as HerdrPane, home, { fresh: false })).toEqual({ path: wire("session_a"), owner: `${process.pid}:${started1 + 500}` });
  } finally {
    Object.defineProperty(process, "platform", platform);
    info.mockRestore();
    probe.mockRestore();
  }
});

it("keeps an idle Kimi's last session while the same process runs in the pane, and only then", () => {
  const { home, wire, lock } = kimiHome("session_a", "session_b");
  const locks = join(home, ".kimi-code", "locks", "sessions");
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w9:p1", [process.pid], home)).toBe(wire("session_a"));
  // the CLI lets go of its lock seconds after a turn ends: the same process still shows its session
  rmSync(join(locks, "session_a.lock"));
  expect(kimiWireForTestPane("w9:p1", [process.pid], home)).toBe(wire("session_a"));
  expect(kimiWireForTestPane("w9:p2", [process.pid], home)).toBeNull();
  expect(kimiWireForTestPane("w9:p1", [process.pid + 1_000_000], home)).toBeNull();
  expect(kimiWireForTestPane("w9:p1", [process.pid], home)).toBeNull();
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w9:p3", [process.pid], home)).toBe(wire("session_a"));
  rmSync(join(locks, "session_a.lock"));
  lock("session_a", { ...liveLock(), pid: process.ppid });
  expect(kimiWireForTestPane("w9:p3", [process.pid], home)).toBeNull();
  rmSync(join(locks, "session_a.lock"));
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w9:p1", [process.pid], home)).toBe(wire("session_a"));
  rmSync(join(locks, "session_a.lock"));
  lock("session_b", liveLock());
  expect(kimiWireForTestPane("w9:p1", [process.pid], home)).toBe(wire("session_b"));
});

it("lets go of an idle Kimi's session once the folder starts another", () => {
  const { home, wire, lock } = kimiHome("session_a");
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w8:p1", [process.pid], home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  expect(kimiWireForTestPane("w8:p1", [process.pid], home)).toBe(wire("session_a"));
  // `/new` while idle: the new session has no lock yet
  const later = new Date(Date.now() + 5_000);
  mkdirSync(join(wire("session_a"), "..", "..", "..", "..", "session_b"));
  utimesSync(join(wire("session_a"), "..", "..", "..", ".."), later, later);
  expect(kimiWireForTestPane("w8:p1", [process.pid], home)).toBeNull();
});

it("lets go of an idle Kimi's session once the user switches to another one with /sessions or /resume", () => {
  const { home, wire, lock } = kimiHome("session_a", "session_b");
  const cwd = "/work";
  writeFileSync(join(wire("session_a"), "..", "..", "..", "state.json"), JSON.stringify({ id: "session_a", version: 2, cwd }));
  const history = join(home, ".kimi-code", "user-history", `${createHash("md5").update(cwd).digest("hex")}.jsonl`);
  mkdirSync(join(history, ".."), { recursive: true });
  writeFileSync(history, jsonl([{ content: "hello" }]));
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w7:p1", [process.pid], home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  appendFileSync(history, jsonl([{ content: "/help" }, { content: "a prompt not sent yet" }]));
  expect(kimiWireForTestPane("w7:p1", [process.pid], home)).toBe(wire("session_a"));
  // picking an existing session writes nothing to the store and takes no lock until its next prompt
  appendFileSync(history, jsonl([{ content: "/resume session_b" }]));
  expect(kimiWireForTestPane("w7:p1", [process.pid], home)).toBeNull();
  expect(kimiWireForTestPane("w7:p1", [process.pid], home)).toBeNull();
  lock("session_b", liveLock());
  expect(kimiWireForTestPane("w7:p1", [process.pid], home)).toBe(wire("session_b"));
});

it("sees a switch typed while the old lock lingers, or written in two pieces", () => {
  const { home, wire, lock } = kimiHome("session_a", "session_b");
  const cwd = "/work";
  writeFileSync(join(wire("session_a"), "..", "..", "..", "state.json"), JSON.stringify({ id: "session_a", version: 2, cwd }));
  const history = join(home, ".kimi-code", "user-history", `${createHash("md5").update(cwd).digest("hex")}.jsonl`);
  mkdirSync(join(history, ".."), { recursive: true });
  writeFileSync(history, jsonl([{ content: "hello" }]));
  const lockA = join(home, ".kimi-code", "locks", "sessions", "session_a.lock");
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  appendFileSync(history, jsonl([{ content: "/sessions" }]));
  const typed = new Date(Date.now() + 500);
  utimesSync(history, typed, typed);
  const writing = new Date(Date.now() + 1_000);
  utimesSync(wire("session_a"), writing, writing);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  appendFileSync(history, jsonl([{ content: "/sessions" }]));
  const typedAgain = new Date(Date.now() + 1_500);
  utimesSync(history, typedAgain, typedAgain);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBeNull();
  rmSync(lockA);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBeNull();
  lock("session_a", { ...liveLock(), startedAt: Date.now() + 1_000 });
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  rmSync(lockA);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  appendFileSync(history, '{"content":"/resu');
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  appendFileSync(history, 'me session_b"}\n');
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBeNull();
  lock("session_a", { ...liveLock(), startedAt: Date.now() + 2_000 });
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBe(wire("session_a"));
  appendFileSync(history, jsonl([{ content: "/sessions" }, { content: "x".repeat(1024 * 1024) }]));
  const later = new Date(Date.now() + 3_000);
  utimesSync(history, later, later);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBeNull();
  rmSync(lockA);
  expect(kimiWireForTestPane("w6:p1", [process.pid], home)).toBeNull();
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("holds an idle Kimi's session only while its folder's history can be read", () => {
  const { home, wire, lock } = kimiHome("session_a");
  const cwd = "/work";
  writeFileSync(join(wire("session_a"), "..", "..", "..", "state.json"), JSON.stringify({ id: "session_a", version: 2, cwd }));
  const history = join(home, ".kimi-code", "user-history", `${createHash("md5").update(cwd).digest("hex")}.jsonl`);
  mkdirSync(join(history, ".."), { recursive: true });
  writeFileSync(history, "");
  lock("session_a", liveLock());
  expect(kimiWireForTestPane("w5:p1", [process.pid], home)).toBe(wire("session_a"));
  rmSync(join(home, ".kimi-code", "locks", "sessions", "session_a.lock"));
  chmodSync(history, 0o000);
  try { expect(kimiWireForTestPane("w5:p1", [process.pid], home)).toBeNull(); } finally { chmodSync(history, 0o600); }
});

it("ignores a lock a crashed process left behind, another host's and a broken one", () => {
  const { home, lock } = kimiHome("session_old", "session_far");
  lock("session_old", { ...liveLock(), startedAt: 1 });
  lock("session_far", { ...liveLock(), hostname: `${hostname()}-elsewhere` });
  lock("session_null", "null");
  lock("session_junk", "{");
  expect(kimiWireForProcesses([process.pid], home)).toBeNull();
});

it("ignores a lock dated where its process may not have started yet", () => {
  const { home, lock } = kimiHome("session_old");
  // the earliest the process may have started (Linux's btime is whole seconds): a lock a dead
  // process wrote then could be one its reused pid never wrote
  lock("session_old", { ...liveLock(), startedAt: testProcessIdentity === undefined ? processStartedAt(process.pid)! : TEST_PROCESS_START - 1 });
  expect(kimiWireForProcesses([process.pid], home)).toBeNull();
});

it("gives no session when the pane's processes hold two", () => {
  const { home, lock } = kimiHome("session_a", "session_b");
  lock("session_a", liveLock());
  lock("session_b", liveLock());
  expect(kimiWireForProcesses([process.pid], home)).toBeNull();
});

it.skipIf(process.platform !== "linux")("without a lock, binds the main wire log the process holds open, never a sub-agent's", () => {
  const { home, wire } = kimiHome("session_m");
  const sub = join(wire("session_m"), "..", "..", "sub1", "wire.jsonl");
  mkdirSync(join(sub, ".."), { recursive: true }); writeFileSync(sub, "");
  const subFd = openSync(sub, "r");
  try {
    expect(kimiWireForProcesses([process.pid], home)).toBeNull();
    const mainFd = openSync(wire("session_m"), "r");
    try { expect(kimiWireForProcesses([process.pid], home)).toBe(wire("session_m")); } finally { closeSync(mainFd); }
  } finally { closeSync(subFd); }
});

it("drops the prompts /undo took back, with their answers", () => {
  const prompt = (text: string) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: text } });
  const answer = (text: string) => ({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text } } });
  const text = jsonl([prompt("one"), answer("A1"), prompt("two"), answer("A2"), { type: "context.undo", count: 1 }, prompt("two-fixed"), answer("A3")]);
  expect(parseKimiTranscript(text).map((turn) => `${turn.role}:${turn.parts.map((part) => part.kind === "text" ? part.text : "").join("")}`))
    .toEqual(["user:one", "assistant:A1", "user:two-fixed", "assistant:A3"]);
});

it("drops what /undo took back from every page, also after a cached read", () => {
  const { wire } = kimiHome("session_u");
  const path = wire("session_u");
  const prompt = (text: string) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text }] } });
  const answer = (text: string) => ({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text } } });
  // what Kimi Code 2.5.0 writes for an /undo of two prompts
  const undo = (count: number) => [{ type: "agent.switched", turns: count, branch: "b1", base: { branch: "main", line: 1 } }, { type: "context.undo", agentId: "main", count }, { type: "context.undone", turns: count }];
  const texts = () => transcriptPage("kimi-transcript", path).turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
  writeFileSync(path, jsonl([prompt("one"), answer("A1"), prompt("two"), answer("A2"), ...undo(2)]));
  expect(texts()).toEqual([]);
  forgetTranscriptState();
  writeFileSync(path, jsonl([prompt("one"), answer("A1"), prompt("two"), answer("A2")]));
  expect(texts()).toEqual(["one", "A1", "two", "A2"]);
  appendFileSync(path, jsonl([...undo(2), prompt("new"), answer("A3")]));
  expect(texts()).toEqual(["new", "A3"]);
  forgetTranscriptState();
  expect(texts()).toEqual(["new", "A3"]);
});

it("drops a prompt /undo took back from an older page", () => {
  const { wire } = kimiHome("session_p");
  const path = wire("session_p");
  const prompt = (text: string) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: text } });
  const turns = Array.from({ length: MAX_PAGE_PROMPTS + 10 }, (_, i) => prompt(`turn ${i}`));
  writeFileSync(path, jsonl([...turns, { type: "context.undo", count: turns.length - 5 }, prompt("after")]));
  const newest = transcriptPage("kimi-transcript", path);
  const shown = (page: typeof newest) => page.turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
  const all = [...shown(newest)];
  for (let page = newest, pages = 0; page.cursor && pages < 5; pages += 1) { page = transcriptPage("kimi-transcript", path, { before: page.cursor, history_id: page.history_id }); all.unshift(...shown(page)); }
  expect(all).toEqual(["turn 0", "turn 1", "turn 2", "turn 3", "turn 4", "after"]);
});

it("drops what an undo still without its newline took back from every page", () => {
  const { wire } = kimiHome("session_n");
  const path = wire("session_n");
  const prompt = (text: string) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: text } });
  const turns = Array.from({ length: MAX_PAGE_PROMPTS + 10 }, (_, i) => prompt(`turn ${i}`));
  writeFileSync(path, jsonl(turns) + JSON.stringify({ type: "context.undo", count: turns.length - 5 }));
  const shown = (page: ReturnType<typeof transcriptPage>) => page.turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
  const newest = transcriptPage("kimi-transcript", path);
  const all = [...shown(newest)];
  for (let page = newest, pages = 0; page.cursor && pages < 5; pages += 1) { page = transcriptPage("kimi-transcript", path, { before: page.cursor, history_id: page.history_id }); all.unshift(...shown(page)); }
  expect(all).toEqual(["turn 0", "turn 1", "turn 2", "turn 3", "turn 4"]);
});

it("never takes back another prompt for one too long to read across a window", () => {
  const { wire } = kimiHome("session_w");
  const path = wire("session_w");
  const prompt = (text: string) => JSON.stringify({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: text } }) + "\n";
  const keep = prompt("keep");
  const pad = JSON.stringify({ type: "padding", text: "x".repeat(TRANSCRIPT_WINDOW_BYTES - keep.length - 70_000 - 40) }) + "\n";
  writeFileSync(path, keep + pad + prompt("y".repeat(100 * 1024)) + jsonl([{ type: "context.undo", count: 1 }]) + prompt("after"));
  const shown = (page: ReturnType<typeof transcriptPage>) => page.turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text.slice(0, 5) : "").join(""));
  const newest = transcriptPage("kimi-transcript", path);
  const all = [...shown(newest)];
  for (let page = newest, pages = 0; page.cursor && pages < 5; pages += 1) { page = transcriptPage("kimi-transcript", path, { before: page.cursor, history_id: page.history_id }); all.unshift(...shown(page)); }
  expect(all[0]).toBe("keep");
  expect(all.at(-1)).toBe("after");
});

it("pages at every prompt the parser shows, an image-only one too", () => {
  const prompt = (content: unknown) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content } });
  const answer = (text: string) => ({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text } } });
  const text = jsonl([prompt("first"), answer("one"), prompt([{ type: "image_url", imageUrl: { url: "file:///x.png" } }]), answer("two")]);
  expect(parseKimiTranscript(text).filter((turn) => turn.role === "user")).toHaveLength(2);
  expect(turnStarts(Buffer.from(text), "kimi-transcript")).toHaveLength(2);
});

it("shows the model of the newest request when it lies between the metadata head and the newest page", () => {
  const { wire } = kimiHome("session_m");
  const path = wire("session_m");
  const request = (model: string, kind = "loop") => ({ type: "llm.request", agentId: "main", kind, provider: "kimi", model, thinkingEffort: "high", toolSelect: true, systemPromptHash: "h", toolsHash: "t", messageCount: 1 });
  const prompt = (text: string) => ({ type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: text } });
  writeFileSync(path, jsonl([
    request("first"), prompt("start"), { type: "padding", text: "x".repeat(70 * 1024) },
    request("second"), request("summarizer", "compaction"),
    ...Array.from({ length: 130 }, (_, i) => prompt(`turn ${i}`)),
  ]));
  const page = transcriptPage("kimi-transcript", path);
  expect(page.cursor).toBeString();
  expect(page.metadata).toEqual({ model: "second", reasoning_effort: "high" });
  forgetTranscriptState();
  expect(transcriptPage("kimi-transcript", path).metadata).toEqual({ model: "second", reasoning_effort: "high" });
  appendFileSync(path, jsonl([request("third")]));
  expect(transcriptPage("kimi-transcript", path).metadata.model).toBe("third");
});

it("cuts a long tool result like the other readers, whole output kept behind the toolCallId", () => {
  const long = "x".repeat(TOOL_OUTPUT_CHARS * 3);
  const wire = [
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_big", name: "Bash", args: { command: "big" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool_big", result: { output: long } } },
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_small", name: "Bash", args: { command: "small" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool_small", result: { output: "ok" } } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const tools = parseKimiTranscript(wire).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
  expect(tools.map((tool) => [tool.output_ref, tool.output_size])).toEqual([["tool_big", long.length], [undefined, undefined]]);
  expect(tools[0]!.output.endsWith("… trimmed")).toBe(true);
  expect(tools[1]).toMatchObject({ output: "ok", state: "ok" });
});

it("skips a null record and a wild timestamp instead of failing the page", () => {
  const wire = [
    "null",
    JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "vorher" } }, time: 9e18 }),
    JSON.stringify({ type: "context.append_message", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "Antwort" } }, time: 1793439036000 }),
  ].join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns).toHaveLength(3);
  expect(turns[0]).toEqual({ role: "assistant", ts: null, parts: [{ kind: "text", text: "vorher" }] });
  expect(turns[1]!.parts).toEqual([{ kind: "text", text: "hi" }]);
  expect(turns[2]).toEqual({ role: "assistant", ts: new Date(1793439036000).toISOString(), parts: [{ kind: "text", text: "Antwort" }] });
});
