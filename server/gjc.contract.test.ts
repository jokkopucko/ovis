import { afterAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GJC_NATIVE_DIRECTORY, GJC_NATIVE_LEASE_MS, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { processStartedAt } from "./process-start.ts";
import { ConversationUnavailable, gjcTranscriptPath, paneConversation } from "./conversation.ts";
import { herdrRpc, herdrSocketPath, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { startShellAgent } from "./shell-agent.ts";
import { createServer } from "./index.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-native-binding-")));
const sessions = join(home, ".gjc", "agent", "sessions", "v2-herdr-test");
const identityDir = join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY);
const script = join(home, "gjc");
const bin = join(home, "bin");
const sdkCalls = join(home, "sdk-calls.log");
const codexHome = join(home, ".codex");
const socketPath = herdrSocketPath();
const workspaces: string[] = [];

mkdirSync(sessions, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(codexHome, { recursive: true });
writeFileSync(script, [
  "if (process.env.GJC_TEST_CWD) process.chdir(process.env.GJC_TEST_CWD);",
  "console.log('GJC fixture ready');",
  "console.log(process.env.GJC_TEST_SCREEN || '');",
  "setInterval(() => {}, 1000);",
  "",
].join("\n"));
writeFileSync(join(bin, "gjc"), `#!/bin/sh\nprintf 'invoked\\n' >> ${shellQuote(sdkCalls)}\nprintf 'GJC SDK must not be invoked by the web UI\\n' >&2\nexit 97\n`, { mode: 0o700 });

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withNativeFixture<T>(run: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "HERDR_SOCKET", "PATH", "CODEX_HOME"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env["HOME"] = home;
  process.env["HERDR_SOCKET"] = socketPath;
  process.env["PATH"] = `${bin}${process.env["PATH"] ? `:${process.env["PATH"]}` : ""}`;
  process.env["CODEX_HOME"] = codexHome;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function until<T>(deadline: number, read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** The stand-in's pid in each pane, as pane() found it in the foreground: one loaded read of process_info may list nothing */
const standInPids = new Map<string, number>();

async function pane(screen = "", cwd = home): Promise<string> {
  const created = await workspaceCreate({ cwd: home, label: "ovis-test-gjc-native-binding" }, socketPath);
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  const command = `GJC_TEST_CWD=${shellQuote(cwd)} GJC_TEST_SCREEN=${shellQuote(screen)} ${shellQuote(process.execPath)} ${shellQuote(script)}\n`;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: command }, socketPath);
  const found = await until(
    Date.now() + 10_000,
    async () => {
      const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
        "pane.process_info", { pane_id: paneId }, socketPath,
      );
      return (info.process_info?.foreground_processes ?? []).find((candidate) => {
        const argv = Array.isArray(candidate.argv) ? candidate.argv.map(String) : [];
        return argv.includes(script) && isGjcProcess(argv);
      })?.pid;
    },
    (pid) => typeof pid === "number",
    "the isolated GJC stand-in in its pane",
  );
  standInPids.set(paneId, found as number);
  return paneId;
}

async function gjcProcess(paneId: string): Promise<{ pid: number; processStartedAt: number }> {
  const pid = standInPids.get(paneId);
  if (pid === undefined) throw new Error("pane() did not find the isolated GJC process");
  const startedAt = processStartedAt(pid);
  if (startedAt === null) throw new Error("Could not read the isolated GJC process birth time");
  return { pid, processStartedAt: startedAt };
}

async function setAgent(paneId: string, agent: string): Promise<void> {
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent, state: "idle" }, socketPath);
  await until(
    Date.now() + 10_000,
    async () => (await sessionSnapshot(socketPath)).panes.find((item) => item.pane_id === paneId)?.agent ?? null,
    (value) => value === agent,
    `herdr to report ${agent} for the fixture pane`,
  );
}

function writeTranscript(cwd: string, answer: string, id = randomUUID(), title = "Native GJC fixture"): { id: string; path: string } {
  const timestamp = new Date().toISOString();
  const path = join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
  const userId = randomUUID();
  const assistantId = randomUUID();
  writeFileSync(path, [
    { type: "session", version: 3, id, timestamp, cwd, title },
    { type: "message", id: userId, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Return the fixture answer." }] } },
    { type: "message", id: assistantId, parentId: userId, timestamp, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { id, path };
}

function binding(
  process: { pid: number; processStartedAt: number },
  session: GjcNativeBinding["session"],
  sequence = 1,
  instanceId = "herdr-contract-extension",
  updatedAt = Date.now(),
): GjcNativeBinding {
  return {
    version: 1,
    pid: process.pid,
    processStartedAt: process.processStartedAt,
    instanceId,
    sequence,
    updatedAt,
    session,
  };
}

function writeBinding(value: GjcNativeBinding): void {
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, `${value.pid}.json`), `${JSON.stringify(value)}\n`);
}

async function waitForScreen(paneId: string, text: string): Promise<void> {
  await until(
    Date.now() + 10_000,
    async () => (await paneRead({ paneId, source: "visible", format: "text" }, socketPath)).text,
    (value) => value.includes(text),
    "the isolated GJC fixture screen",
  );
}

async function expectConversation(paneId: string, answer: string): Promise<void> {
  const conversation = await paneConversation(paneId);
  expect(conversation.source).toBe("gjc-transcript");
  expect(conversation.turns.find((turn) => turn.role === "assistant")?.parts).toContainEqual({ kind: "text", text: answer });
}

async function apiConversation(paneId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const stateDir = mkdtempSync(join(home, "api-state-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function expectSdkNotInvoked(): void {
  expect(existsSync(sdkCalls)).toBe(false);
}

afterAll(async () => {
  const previousSocket = process.env["HERDR_SOCKET"];
  const failures: string[] = [];
  process.env["HERDR_SOCKET"] = socketPath;
  try {
    for (const workspace of [...workspaces].reverse()) {
      try { await workspaceClose(workspace, socketPath); }
      catch (error) { failures.push(`${workspace}: ${String(error)}`); }
    }
  } finally {
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previousSocket;
  }
  if (failures.length > 0) throw new Error(`Could not close isolated GJC fixture workspaces: ${failures.join("; ")}`);
  rmSync(home, { recursive: true, force: true });
});

it("binds the visible neighboring answer to the exact native process record without invoking the SDK", async () => withNativeFixture(async () => {
  const neighboringAnswer = "This long adjacent answer would reveal an incorrect screen-based transcript guess.";
  const target = writeTranscript(home, "OK");
  writeTranscript(home, neighboringAnswer);
  const paneId = await pane(neighboringAnswer);
  await waitForScreen(paneId, neighboringAnswer.slice(0, 35));
  await setAgent(paneId, "gjc");
  const process = await gjcProcess(paneId);
  const record = binding(process, { id: target.id, path: target.path, cwd: home });
  writeBinding(record);

  expect(JSON.parse(readFileSync(join(identityDir, `${process.pid}.json`), "utf8"))).toEqual(record);
  expect(await gjcTranscriptPath(paneId, home, home)).toBe(target.path);
  await expectConversation(paneId, "OK");
  expectSdkNotInvoked();
}));

it("binds same-cwd panes independently by native PID despite identical screen text and mtimes", async () => withNativeFixture(async () => {
  const first = writeTranscript(home, "same answer");
  const second = writeTranscript(home, "same answer");
  const firstPane = await pane("same answer");
  const secondPane = await pane("same answer");
  await waitForScreen(firstPane, "same answer");
  await waitForScreen(secondPane, "same answer");
  await setAgent(firstPane, "gjc");
  await setAgent(secondPane, "gjc");
  const firstProcess = await gjcProcess(firstPane);
  const secondProcess = await gjcProcess(secondPane);
  expect(firstProcess.pid).not.toBe(secondProcess.pid);
  const sameTime = new Date(Date.now() - 60_000);
  utimesSync(first.path, sameTime, sameTime);
  utimesSync(second.path, sameTime, sameTime);
  writeBinding(binding(firstProcess, { id: first.id, path: first.path, cwd: home }));
  writeBinding(binding(secondProcess, { id: second.id, path: second.path, cwd: home }));

  expect(await gjcTranscriptPath(firstPane, home, home)).toBe(first.path);
  expect(await gjcTranscriptPath(secondPane, home, home)).toBe(second.path);
  await expectConversation(firstPane, "same answer");
  await expectConversation(secondPane, "same answer");
  expectSdkNotInvoked();
}));

it("follows a same-PID /new or resume session change when visible text is unchanged", async () => withNativeFixture(async () => {
  const first = writeTranscript(home, "first answer");
  const next = writeTranscript(home, "replacement answer");
  const visible = "the same visible response";
  const paneId = await pane(visible);
  await waitForScreen(paneId, visible);
  await setAgent(paneId, "gjc");
  const process = await gjcProcess(paneId);
  const instanceId = "single-extension-instance";
  writeBinding(binding(process, { id: first.id, path: first.path, cwd: home }, 1, instanceId));
  expect(await gjcTranscriptPath(paneId, home, home)).toBe(first.path);

  writeBinding(binding(process, { id: next.id, path: next.path, cwd: home }, 2, instanceId));
  expect((await paneRead({ paneId, source: "visible", format: "text" }, socketPath)).text).toContain(visible);
  expect(await gjcTranscriptPath(paneId, home, home)).toBe(next.path);
  await expectConversation(paneId, "replacement answer");
  expectSdkNotInvoked();
}));

it("uses the foreground GJC identity instead of stale provider-child session metadata", async () => withNativeFixture(async () => {
  const target = writeTranscript(home, "native GJC answer");
  const paneId = await pane("native GJC answer");
  await waitForScreen(paneId, "native GJC answer");
  await herdrRpc("pane.report_agent_session", {
    pane_id: paneId,
    source: "herdr:codex",
    agent: "codex",
    seq: Date.now(),
    agent_session_id: "01a0f16d-c20a-7a02-a880-e89b68155802",
  }, socketPath);
  const metadata = (await sessionSnapshot(socketPath)).panes.find((item) => item.pane_id === paneId)!;
  expect(metadata.agent ?? null).toBeNull();
  expect(metadata.agent_session?.agent).toBe("codex");
  const process = await gjcProcess(paneId);
  writeBinding(binding(process, { id: target.id, path: target.path, cwd: home }));

  await expectConversation(paneId, "native GJC answer");
  expectSdkNotInvoked();
}));

for (const scenario of ["missing", "stale", "invalid"] as const) {
  it(`falls back to scrollback when the native GJC binding is ${scenario}`, async () => withNativeFixture(async () => {
    const screenAnswer = "A valid neighboring transcript must not be guessed from this visible answer.";
    const decoy = writeTranscript(home, screenAnswer);
    const paneId = await pane(screenAnswer);
    await waitForScreen(paneId, screenAnswer.slice(0, 35));
    await setAgent(paneId, "gjc");
    const process = await gjcProcess(paneId);
    if (scenario !== "missing") {
      mkdirSync(identityDir, { recursive: true });
      const current = binding(process, { id: decoy.id, path: decoy.path, cwd: home }, 1, `invalid-${scenario}`,
        scenario === "stale" ? Date.now() - GJC_NATIVE_LEASE_MS : Date.now());
      if (scenario === "stale") writeBinding(current);
      else writeFileSync(join(identityDir, `${process.pid}.json`), JSON.stringify({ ...current, version: 2 }));
    }

    const response = await apiConversation(paneId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: "scrollback", turns: [] });
    expectSdkNotInvoked();
  }));
}

it("uses the GJC process foreground cwd rather than its pane shell cwd", async () => withNativeFixture(async () => {
  const cwd = join(home, "foreground-project");
  mkdirSync(cwd);
  const target = writeTranscript(cwd, "foreground cwd answer");
  const paneId = await pane("foreground cwd answer", cwd);
  await waitForScreen(paneId, "foreground cwd answer");
  await setAgent(paneId, "gjc");
  const process = await gjcProcess(paneId);
  const metadata = await until(
    Date.now() + 10_000,
    async () => (await sessionSnapshot(socketPath)).panes.find((item) => item.pane_id === paneId) ?? null,
    (value) => value?.foreground_cwd === cwd,
    "the GJC process foreground cwd",
  );
  if (!metadata) throw new Error("The fixture pane disappeared while waiting for its foreground cwd");
  expect(metadata.cwd).toBe(home);
  expect(metadata.foreground_cwd).toBe(cwd);
  writeBinding(binding(process, { id: target.id, path: target.path, cwd }));

  expect(await gjcTranscriptPath(paneId, cwd, home)).toBe(target.path);
  await expectConversation(paneId, "foreground cwd answer");
  expectSdkNotInvoked();
}));

it("does not route a named non-GJC agent through a foreground GJC process", async () => withNativeFixture(async () => {
  const target = writeTranscript(home, "must not be selected");
  const paneId = await pane("must not be selected");
  await waitForScreen(paneId, "must not be selected");
  await setAgent(paneId, "codex");
  const process = await gjcProcess(paneId);
  writeBinding(binding(process, { id: target.id, path: target.path, cwd: home }));

  await expect(paneConversation(paneId)).rejects.toBeInstanceOf(ConversationUnavailable);
  expectSdkNotInvoked();
}));

it("starts the GJC executable found on the server PATH by absolute path", async () => withNativeFixture(async () => {
  const spacedBin = join(home, "agent bin");
  mkdirSync(spacedBin);
  const executable = join(spacedBin, "gjc");
  writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
  const previousPath = process.env["PATH"];
  try {
    process.env["PATH"] = `${spacedBin}:${previousPath ?? ""}`;
    const created = await workspaceCreate({ cwd: home, label: "ovis-test-gjc-start" }, socketPath);
    workspaces.push(created.workspace.workspace_id);
    await startShellAgent("gjc", created.root_pane.pane_id, [sessions]);
    // read until herdr shows it: one read right after the start can still miss the process it reported in front (#1462)
    const gjcArgv = (info: { process_info?: { foreground_processes?: { argv?: string[] }[] } }) =>
      info.process_info?.foreground_processes?.find((candidate) => isGjcProcess(candidate.argv ?? []))?.argv;
    const info = await until(Date.now() + 10_000,
      () => herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: created.root_pane.pane_id }, socketPath),
      (read) => gjcArgv(read)?.at(-1) === sessions, "the started gjc, given the sessions directory, in the pane's foreground");
    expect(gjcArgv(info)?.slice(-1)).toEqual([sessions]);

    process.env["PATH"] = "/nonexistent";
    const missing = await workspaceCreate({ cwd: home, label: "ovis-test-gjc-missing" }, socketPath);
    workspaces.push(missing.workspace.workspace_id);
    await expect(startShellAgent("gjc", missing.root_pane.pane_id, [], { timeoutMs: 1500 })).rejects.toThrow("not on this server's PATH");
    expect((await paneRead({ paneId: missing.root_pane.pane_id }, socketPath)).text.replaceAll(home, "")).not.toContain("gjc");
  } finally {
    if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
  }
  expectSdkNotInvoked();
}));
