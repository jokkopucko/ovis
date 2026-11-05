import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneProcessInfo, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import { copilotHandoffSession, copilotProcessSession } from "./copilot-store.ts";
import { processEnviron } from "./omo.ts";
import * as processOwner from "./process-owner.ts";

const id = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
const root = mkdtempSync(join(tmpdir(), "herdr-copilot-contract-"));
const home = join(root, "custom-home");
const executable = join(root, "copilot.js");
const file = (session: string) => join(home, "session-state", session, "events.jsonl");
const event = (type: string, data: object) => JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: "2026-10-21T00:00:00Z", parentId: null }) + "\n";
const fixture = (session: string, content: string) =>
  event("session.start", { sessionId: session, copilotVersion: "1.0.102-1" })
  + event("user.message", { content, transformedContent: "not shown", parentAgentTaskId: "root-task-id" })
  + event("assistant.message", { content: "fixture response", phase: "final_answer", model: "fixture-model" });
let app: ReturnType<typeof createServer>;
let workspace: string;
let pane: string;

/** The stand-in for this session in front of a pane, by its own process: herdr's agent label can outlast one that quit. */
async function fixtureInFront(pane: string, session: string): Promise<number | undefined> {
  return (await paneProcessInfo(pane))?.foreground_processes?.find((process) => process.argv?.includes(executable) && process.argv.includes(session))?.pid;
}

async function startFixture(pane: string, session: string, flags = "") {
  await herdrRpc("pane.send_text", { pane_id: pane, text: `COPILOT_HOME=${home} node ${executable} ${session}${flags ? ` ${flags}` : ""}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "copilot" && await fixtureInFront(pane, session) !== undefined) return;
    if (Date.now() > deadline) throw new Error(`isolated Copilot stand-in not detected in ${pane}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  if (process.platform !== "linux") return;
  for (const session of [id, other]) mkdirSync(join(home, "session-state", session), { recursive: true });
  writeFileSync(executable, `import { openSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const home = process.env.COPILOT_HOME;
const hold = (id) => { const dir = join(home, "session-state", id); mkdirSync(dir, { recursive: true }); openSync(join(dir, \`inuse.\${process.pid}.hold\`), "w"); };
const lifecycle = process.argv.includes("--lifecycle");
const log = join(home, "logs", \`process-100-\${process.pid}.log\`);
let selected = process.argv[2];
mkdirSync(join(home, "logs"), { recursive: true });
openSync(log, "w");
if (lifecycle) {
  appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + selected + "\\n");
} else if (!process.argv.includes("--no-proof") && !process.argv.includes("--handoff")) hold(selected);
let child;
if (process.argv.includes("--handoff")) {
  if (!process.argv.includes("--initial-unregister")) appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + selected + "\\n");
  appendFileSync(log, new Date().toISOString() + " [INFO] Unregistering foreground session: " + selected + "\\n");
  child = spawn(process.execPath, [process.argv[1], selected, "--prefer-version", "1.0.104-3", "--session-id", selected, "--handoff-child"], { stdio: "inherit" });
  process.on("exit", () => child.kill());
}
if (process.argv.includes("--handoff-child")) setInterval(() => {}, 1000);
else {
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) !== -1;) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (line.startsWith(":hold ")) hold(line.slice(6));
    else if (line.startsWith(":switch ") && lifecycle) {
      const next = line.slice(8);
      appendFileSync(log, new Date().toISOString() + " [INFO] Unregistering foreground session: " + selected + "\\n");
      appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + next + "\\n");
      selected = next;
    }
    else if (line === ":unregister" && lifecycle) {
      appendFileSync(log, new Date().toISOString() + " [INFO] Unregistering foreground session: " + selected + "\\n");
    }
    else if (line.startsWith(":register ") && lifecycle) {
      selected = line.slice(10);
      appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + selected + "\\n");
    }
    else if (line === ":quit") process.exit(0);
    else appendFileSync(join(home, "input.txt"), line + "\\n");
  }
});
}
console.log("fixture ready");`);
  chmodSync(executable, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-api" });
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await startFixture(pane, id);
  app = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"), tailscaleOwner: null });
});

afterAll(async () => {
  app?.stop();
  if (workspace) await workspaceClose(workspace);
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

const handoffTest = async (initialRegistration: boolean) => {
  const handoffId = "12aa83d8-48bc-41f2-a498-7055c5c44a06";
  mkdirSync(join(home, "session-state", handoffId), { recursive: true });
  writeFileSync(file(handoffId), fixture(handoffId, "handoff history"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-handoff" });
  const current = created.root_pane.pane_id;
  let child = 0;
  let failed = false;
  try {
    await startFixture(current, handoffId, `--resume=${handoffId} --handoff${initialRegistration ? "" : " --initial-unregister"}`);
    let parent = 0;
    for (const deadline = Date.now() + 10_000;;) {
      const info = await paneProcessInfo(current);
      const processes = info?.foreground_processes ?? [];
      parent = processes.find((process) => process.argv?.some((word) => word === "--handoff"))?.pid ?? 0;
      child = processes.find((process) => process.argv?.some((word) => word === "--handoff-child"))?.pid ?? 0;
      if (parent && child) break;
      if (Date.now() > deadline) throw new Error("handoff processes did not join the foreground group");
      await Bun.sleep(50);
    }
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    const read = async () => (await fetch(url)).json() as Promise<{ source: string; turns: { parts: { text?: string }[] }[] }>;
    expect((await read()).source).toBe("scrollback");
    await herdrRpc("pane.report_agent_session", { pane_id: current, agent: "copilot", source: "herdr:copilot",
      seq: Date.now() * 1000, agent_session_id: handoffId });
    const info = await paneProcessInfo(current);
    const entries = info?.foreground_processes ?? [];
    const parentEntry = entries.find((entry) => entry.pid === parent)!;
    const childEntry = entries.find((entry) => entry.pid === child)!;
    const differentHome = join(root, "different-store");
    mkdirSync(join(differentHome, "session-state", handoffId), { recursive: true });
    expect(copilotHandoffSession({ pid: parent, argv: parentEntry.argv ?? [] },
      { pid: child, argv: childEntry.argv ?? [] }, handoffId, info?.foreground_process_group_id, info?.tty,
      (pid) => pid === child ? [`COPILOT_HOME=${differentHome}`] : processEnviron(pid))).toBeNull();
    const ownership = copilotHandoffSession({ pid: parent, argv: parentEntry.argv ?? [] },
      { pid: child, argv: childEntry.argv ?? [] }, handoffId, info?.foreground_process_group_id, info?.tty, processEnviron);
    expect({ owner: ownership?.sessionId, parent: copilotProcessSession(processEnviron(parent), parentEntry.argv ?? [], parent, "unregistered")?.sessionId,
      child: copilotProcessSession(processEnviron(child), childEntry.argv ?? [], child)?.sessionId,
      report: (await sessionSnapshot()).panes.find((p) => p.pane_id === current)?.agent_session?.value,
      source: (await read()).source }).toEqual({
      owner: handoffId, parent: handoffId, child: handoffId, report: handoffId, source: "copilot-transcript",
    });
    expect((await read()).turns[0]?.parts[0]?.text).toBe("handoff history");
    const parentLog = join(home, "logs", `process-100-${parent}.log`);
    const parentProcess = { pid: parent, argv: parentEntry.argv ?? [] };
    const childProcess = { pid: child, argv: childEntry.argv ?? [] };
    const group = info?.foreground_process_group_id;
    const tty = info?.tty ?? fs.realpathSync(`/proc/${parent}/fd/0`);
    expect(group).toBeGreaterThan(0);
    expect(tty).toMatch(/^\/dev\//);
    const handoff = () => copilotHandoffSession(parentProcess, childProcess, handoffId, group, tty, processEnviron);
    expect(copilotHandoffSession({ ...parentProcess, argv: ["copilot"] }, childProcess, handoffId, group, tty, processEnviron)).toBeNull();
    expect(copilotHandoffSession(parentProcess, { ...childProcess, argv: ["copilot"] }, handoffId, group, tty, processEnviron)).toBeNull();
    expect(copilotHandoffSession(childProcess, parentProcess, handoffId, group, tty, processEnviron)).toBeNull();
    expect(copilotHandoffSession(parentProcess, childProcess, other, group, tty, processEnviron)).toBeNull();
    expect(copilotHandoffSession(parentProcess, childProcess, handoffId, group! + 1, tty, processEnviron)).toBeNull();
    expect(copilotHandoffSession(parentProcess, childProcess, handoffId, group, "/dev/null", processEnviron)).toBeNull();
    const realRead = fs.readFileSync;
    const childStat = `/proc/${child}/stat`;
    const statText = realRead(childStat, "utf8");
    const fields = statText.slice(statText.lastIndexOf(") ") + 2).split(" ");
    fields[1] = "1";
    const changedParent = statText.slice(0, statText.lastIndexOf(") ") + 2) + fields.join(" ");
    function alteredStat(path: fs.PathOrFileDescriptor, options?: { encoding?: null; flag?: string } | null): Buffer<ArrayBuffer>;
    function alteredStat(path: fs.PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string } | BufferEncoding): string;
    function alteredStat(path: fs.PathOrFileDescriptor, options?: (fs.ObjectEncodingOptions & { flag?: string }) | BufferEncoding | null): Buffer<ArrayBuffer> | string;
    function alteredStat(path: fs.PathOrFileDescriptor, options?: (fs.ObjectEncodingOptions & { flag?: string }) | BufferEncoding | null): Buffer<ArrayBuffer> | string {
      if (path === childStat) return typeof options === "string" || options?.encoding ? changedParent : Buffer.from(changedParent);
      return realRead(path, options);
    }
    const ancestry = spyOn(fs, "readFileSync").mockImplementation(alteredStat);
    try { expect(handoff()).toBeNull(); } finally { ancestry.mockRestore(); }
    expect(handoff()?.sessionId).toBe(handoffId);
    const realBirth = processOwner.readProcessBirth;
    const unavailableStart = spyOn(processOwner, "readProcessBirth").mockImplementation((pid) => pid === parent ? { state: "unknown" } : realBirth(pid));
    try {
      writeFileSync(parentLog, new Date().toISOString() + " [INFO] Registering foreground session: " + other + "\n");
      expect(copilotProcessSession(processEnviron(parent), parentProcess.argv, parent, "unregistered")).toBeNull();
      expect(handoff()).toBeNull();
    } finally { unavailableStart.mockRestore(); }
    expect(handoff()).toBeNull();
    appendFileSync(parentLog, new Date().toISOString() + " [INFO] Registering foreground session: " + handoffId + "\n"
      + new Date().toISOString() + " [INFO] Unregistering foreground session: " + handoffId + "\n");
    expect(handoff()?.sessionId).toBe(handoffId);
    appendFileSync(parentLog, new Date().toISOString() + " [INFO] Registering foreground session: " + handoffId + "\n");
    expect((await read()).source).toBe("scrollback");
    appendFileSync(parentLog, new Date().toISOString() + " [INFO] Unregistering foreground session: " + handoffId);
    expect((await read()).source).toBe("scrollback");
    appendFileSync(parentLog, "\n");
    expect((await read()).turns[0]?.parts[0]?.text).toBe("handoff history");
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-handoff-peer" });
    try {
      await startFixture(duplicate.root_pane.pane_id, handoffId);
      await herdrRpc("pane.report_agent_session", { pane_id: duplicate.root_pane.pane_id, agent: "copilot",
        source: "herdr:copilot", seq: Date.now() * 1000 + 1, agent_session_id: handoffId });
      await expect(paneConversation(current)).rejects.toMatchObject({
        message: "no_session_path", diagnostic: "copilot_peer_conflict",
      });
      expect((await read()).source).toBe("scrollback");
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    expect((await read()).turns[0]?.parts[0]?.text).toBe("handoff history");
    process.kill(child, "SIGTERM");
    for (const deadline = Date.now() + 4000;;) {
      if ((await read()).source === "scrollback") break;
      if (Date.now() > deadline) throw new Error("lost child ownership did not disable history");
      await Bun.sleep(50);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (child) {
      try { process.kill(child, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(`child ${child}: ${String(error)}`);
      }
    }
    try { await workspaceClose(created.workspace.workspace_id); }
    catch (error) { cleanupErrors.push(`workspace ${created.workspace.workspace_id}: ${String(error)}`); }
    if (cleanupErrors.length > 0) {
      const message = `Copilot handoff cleanup failed: ${cleanupErrors.join("; ")}`;
      if (failed) console.error(message);
      else throw new Error(message);
    }
  }
};

it.skipIf(process.platform !== "linux")("binds only the reported UUID to the foreground process's home and rejects old cursors after a switch", async () => {
  const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`;
  const read = async () => (await fetch(url)).json() as Promise<{ source: string; turns: { parts: { kind?: string; text?: string; output_ref?: string }[] }[]; cursor?: string; history_id?: string }>;
  const external = await read();
  expect(external.source).toBe("copilot-transcript");
  expect(external.turns).toEqual([]);
  expect(external.history_id).toBe(`unwritten:${id}`);
  expect((await read()).history_id).toBe(external.history_id);
  expect((await fetch(`${url}&from=old-history`)).status).toBe(409);
  writeFileSync(file(id), fixture(id, "session A"));
  expect((await read()).source).toBe("scrollback");
  const report = async (session: string, seq: number, source = "herdr:copilot", paneId = pane) => {
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, agent: "copilot", source, seq: Date.now() * 1000 + seq, agent_session_id: session });
  };
  await report(id, 1, "untrusted");
  expect((await read()).source).toBe("scrollback");
  await report(id, 2);
  const header = event("session.start", { sessionId: id });
  writeFileSync(file(id), header);
  expect((await read()).source).toBe("copilot-transcript");
  expect((await read()).turns).toEqual([]);
  for (const record of [
    event("user.message", { content: [{ type: "text", text: "unsupported prompt" }] }),
    event("assistant.message", { content: [{ type: "text", text: "unsupported answer" }] }),
    event("assistant.message", { toolRequests: ["unreadable request"] }),
    event("assistant.message", { content: "", toolRequests: { toolCallId: "call", name: "shell" } }),
    "malformed complete record\n",
  ]) {
    writeFileSync(file(id), header + record);
    expect((await read()).source).toBe("scrollback");
  }
  writeFileSync(file(id), fixture(id, "session A"));
  const first = await read();
  expect(first.source).toBe("copilot-transcript");
  expect(first.history_id).not.toBe(external.history_id);
  expect(first.turns[0]?.parts[0]?.text).toBe("session A");
  appendFileSync(file(id), event("assistant.message", { content: "Checking.", phase: "commentary",
    toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: { command: "pwd" } }], model: "fixture-model" }));
  const toolUrl = (ref: string) => `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: pane, ref })}`;
  expect((await read()).turns.at(-1)?.parts.at(-1)).toMatchObject({ kind: "tool", output: "" });
  appendFileSync(file(id), event("tool.execution_start", { toolCallId: "call-1", toolName: "shell" })
    + event("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "error ".repeat(900) } }));
  const completed = (await read()).turns.at(-1)?.parts.at(-1);
  if (completed?.kind !== "tool" || !completed.output_ref) throw new Error("fixture tool output ref missing");
  const completedRef = completed.output_ref;
  expect(completed).toMatchObject({ kind: "tool", error: true });
  expect(completedRef).toMatch(/^cp[0-9a-f]{16}\.call-1@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
  expect((await fetch(toolUrl("call-1"))).status).toBe(404);
  expect((await fetch(toolUrl(completedRef.slice(0, completedRef.indexOf("@"))))).status).toBe(404);
  expect(await (await fetch(toolUrl(completedRef))).text()).toBe("error ".repeat(900));
  appendFileSync(file(id), event("session.resume", { selectedModel: "fixture-model" }) + event("user.message", { content: "appended" }));
  expect((await read()).history_id).toBe(first.history_id);
  expect((await read()).turns.at(-1)?.parts[0]?.text).toBe("appended");
  writeFileSync(file(other), fixture(other, "session B"));
  const second = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-peer" });
  try {
    const peer = second.root_pane.pane_id;
    await startFixture(peer, other);
    await report(other, 1, "herdr:copilot", peer);
    const peerUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(peer)}`;
    expect((await (await fetch(peerUrl)).json()).turns[0].parts[0].text).toBe("session B");
    expect((await read()).turns[0]?.parts[0]?.text).toBe("session A");
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-duplicate" });
    try {
      const claimant = duplicate.root_pane.pane_id;
      await startFixture(claimant, id);
      await report(id, 1, "herdr:copilot", claimant);
      expect((await read()).source).toBe("scrollback");
      const claimantUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(claimant)}`;
      expect((await (await fetch(claimantUrl)).json()).source).toBe("scrollback");
      expect((await (await fetch(peerUrl)).json()).source).toBe("copilot-transcript");
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    expect((await read()).source).toBe("copilot-transcript");
  } finally { await workspaceClose(second.workspace.workspace_id); }
  await herdrRpc("pane.send_text", { pane_id: pane, text: `:hold ${other}\n` });
  for (const deadline = Date.now() + 4000;;) {
    if ((await read()).source === "scrollback") break;
    if (Date.now() > deadline) throw new Error("ambiguous native holds did not disable chat");
    await Bun.sleep(50);
  }
  await report(other, 3);
  // Herdr 0.9.3 ignores a replacement Copilot ID. Its stale old ID must not
  // show that old session as if it belonged to the now-switched pane.
  expect((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent_session?.value).toBe(id);
  expect((await read()).source).toBe("scrollback");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  expect((await fetch(toolUrl(completedRef))).status).toBe(404);
  // the stand-in quits. Its process leaving the pane is the exit; herdr must also forget the Copilot
  // session reported for it, or herdr 0.9.3 ignores the next stand-in's report: the session this test
  // reported is released, as Copilot's own hook would at its exit, rather than left to herdr's detection
  const quitting = await fixtureInFront(pane, id);
  if (quitting === undefined) throw new Error(`the stand-in for ${id} is not in front of ${pane}: ${JSON.stringify((await paneProcessInfo(pane))?.foreground_processes)}`);
  await herdrRpc("pane.send_text", { pane_id: pane, text: ":quit\n" });
  const quitState = async () => {
    const label = (await sessionSnapshot()).panes.find((p) => p.pane_id === pane);
    const state = (() => { try { return fs.readFileSync(`/proc/${quitting}/stat`, "utf8").split(") ")[1]?.split(" ")[0] ?? "?"; } catch { return "gone"; } })();
    return JSON.stringify({ pid: quitting, state, front: (await paneProcessInfo(pane))?.foreground_processes?.map((process) => [process.pid, process.argv]), agent: label?.agent, status: label?.agent_status, session: label?.agent_session });
  };
  for (const deadline = Date.now() + 10_000; (await paneProcessInfo(pane))?.foreground_processes?.some((process) => process.pid === quitting);) {
    if (Date.now() > deadline) throw new Error(`isolated fixture did not exit: ${await quitState()}`);
    await Bun.sleep(50);
  }
  await herdrRpc("pane.release_agent", { pane_id: pane, source: "herdr:copilot", agent: "copilot" });
  for (const deadline = Date.now() + 10_000; (await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "copilot";) {
    if (Date.now() > deadline) throw new Error(`herdr still names the quit stand-in: ${await quitState()}`);
    await Bun.sleep(50);
  }
  await startFixture(pane, other);
  await report(other, 4);
  expect((await read()).turns[0]?.parts[0]?.text).toBe("session B");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  writeFileSync(file(other), fixture(id, "wrong header"));
  expect((await read()).source).toBe("scrollback");
  rmSync(file(other));
  expect((await read()).source).toBe("scrollback");
  symlinkSync(file(id), file(other));
  expect((await read()).source).toBe("scrollback");
}, 20_000);

it.skipIf(process.platform !== "linux")("retries failed Copilot page reads only while fresh ownership and file generation still agree", async () => {
  const session = "12aa83d8-48bc-41f2-a498-7055c5c44a07";
  const switched = "12aa83d8-48bc-41f2-a498-7055c5c44a08";
  for (const id of [session, switched]) {
    mkdirSync(join(home, "session-state", id), { recursive: true });
    writeFileSync(file(id), fixture(id, "retained history")
      + Array.from({ length: 55 }, (_, i) => event("user.message", { content: `prompt ${i}` })).join(""));
  }
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-read-retry" });
  const current = created.root_pane.pane_id;
  const realRead = fs.readSync;
  let failingFile = file(session);
  let fail = false;
  let onFailure = () => {};
  function failedRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
  function failedRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
  function failedRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
    // Leave the bounded header/identity checks real; fail only a transcript page read.
    if (fail && (length ?? 0) > 64 * 1024 && fs.readlinkSync(`/proc/self/fd/${fd}`) === failingFile) {
      fail = false;
      onFailure();
      throw Object.assign(new Error("synthetic private path must not escape"), { code: "EIO" });
    }
    return typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
  }
  let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
  const append = () => appendFileSync(failingFile, event("assistant.message", { content: "fixture ".repeat(10_000) }));
  try {
    await startFixture(current, session, "--lifecycle");
    const info = await paneProcessInfo(current);
    const pid = info?.foreground_processes?.find((process) => process.argv?.includes(executable))?.pid;
    expect(pid).toBeDefined();
    const log = join(home, "logs", `process-100-${pid}.log`);
    const lifecycle = (id: string, action = "Registering") =>
      appendFileSync(log, `${new Date().toISOString()} [INFO] ${action} foreground session: ${id}\n`);
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    reads = spyOn(fs, "readSync").mockImplementation(failedRead);
    // CI once read no cursor here for a reason its log did not keep: each answer waited past is
    // printed, so a run that waits says what it saw
    const readCursor = async () => {
      for (const deadline = Date.now() + 5000;;) {
        const response = await fetch(url);
        const body = await response.json() as { cursor?: string; history_id?: string };
        if (response.status === 200 && typeof body.cursor === "string") return body as { cursor: string; history_id: string };
        console.warn(`Copilot cursor not ready yet: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
        if (Date.now() > deadline) throw new Error(`Copilot cursor was not ready: ${response.status} ${JSON.stringify(body)}`);
        await Bun.sleep(50);
      }
    };
    const initial = await readCursor();
    expect(initial.cursor).toBeString();
    append(); fail = true;
    const legacyFailure = await fetch(url);
    expect(legacyFailure.status).toBe(200);
    expect(await legacyFailure.json()).toEqual({ source: "scrollback", turns: [] });
    expect(fail).toBe(false);
    for (const query of [`&history_id=${encodeURIComponent(initial.history_id)}`, `&from=${encodeURIComponent(initial.cursor)}`, `&before=${encodeURIComponent(initial.cursor)}`]) {
      append(); fail = true;
      const failed = await fetch(url + query, { headers: { "if-none-match": '"old-answer"' } });
      expect(failed.status).toBe(503);
      expect(failed.headers.get("etag")).toBeNull();
      expect(failed.headers.get("cache-control")).toBe("no-store");
      expect(await failed.json()).toEqual({ error: {
        code: "conversation_read_pending", message: "The conversation could not be read; try again shortly.",
      } });
      expect(fail).toBe(false);
      const recovered = await fetch(url);
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).history_id).toBe(initial.history_id);
    }
    lifecycle(switched);
    failingFile = file(switched);
    append(); fail = true;
    const switchedBeforeRead = await fetch(`${url}&history_id=${encodeURIComponent(initial.history_id)}`);
    expect(fail).toBe(false);
    expect(switchedBeforeRead.status).toBe(409);
    expect((await (await fetch(url)).json()).history_id).not.toBe(initial.history_id);
    failingFile = file(session);
    lifecycle(session);
    appendFileSync(file(session), "malformed complete record\n");
    expect((await (await fetch(url)).json()).source).toBe("scrollback");
    writeFileSync(file(session), fixture(session, "recovered history")
      + Array.from({ length: 55 }, (_, i) => event("user.message", { content: `recovered prompt ${i}` })).join(""));
    for (const selector of ["", "from", "before"]) {
      lifecycle(session);
      const before = await readCursor();
      expect(before.cursor).toBeString();
      append(); fail = true; onFailure = () => lifecycle(session, "Unregistering");
      const revoked = await fetch(url + (selector ? `&${selector}=${encodeURIComponent(before.cursor)}` : ""));
      expect(fail).toBe(false);
      expect(revoked.status).toBe(selector ? 409 : 200);
      if (!selector) expect(await revoked.json()).toEqual({ source: "scrollback", turns: [] });
    }
    for (const paged of [false, true]) {
      lifecycle(session);
      const before = await readCursor();
      expect(before.cursor).toBeString();
      append(); fail = true; onFailure = () => lifecycle(switched);
      const changed = await fetch(url + (paged ? `&from=${encodeURIComponent(before.cursor)}` : ""));
      expect(fail).toBe(false);
      expect(changed.status).toBe(paged ? 409 : 200);
      if (!paged) expect(await changed.json()).toEqual({ source: "scrollback", turns: [] });
    }
    lifecycle(session);
    await fetch(url);
    append(); fail = true; onFailure = () => {
      rmSync(file(session));
      writeFileSync(file(session), fixture(session, "replacement file"));
    };
    const replaced = await fetch(url);
    expect(fail).toBe(false);
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ source: "scrollback", turns: [] });
    onFailure = () => {};
    const displayed = await (await fetch(url)).json() as { history_id: string };
    expect(displayed.history_id).toBeString();
    fs.renameSync(file(session), `${file(session)}.replaced`);
    writeFileSync(file(session), fixture(session, "replaced before the next refresh"));
    append(); fail = true;
    const replacedBeforeRead = await fetch(`${url}&history_id=${encodeURIComponent(displayed.history_id)}`);
    expect(fail).toBe(false);
    expect(replacedBeforeRead.status).toBe(409);
    expect((await (await fetch(url)).json()).history_id).not.toBe(displayed.history_id);
    for (const selector of ["from", "before"]) {
      writeFileSync(file(session), fixture(session, "file removed during the read")
        + Array.from({ length: 55 }, (_, i) => event("user.message", { content: `prompt ${i}` })).join(""));
      lifecycle(session);
      const before = await readCursor();
      expect(before.cursor).toBeString();
      append(); fail = true; onFailure = () => rmSync(file(session));
      const missing = await fetch(`${url}&${selector}=${encodeURIComponent(before.cursor)}`);
      expect(fail).toBe(false);
      expect(missing.status).toBe(409);
      expect((await missing.json()).error.code).toBe("history_changed");
    }
  } finally { reads?.mockRestore(); await workspaceClose(created.workspace.workspace_id); }
}, 20_000);

it.skipIf(process.platform !== "linux")("reads a resumed CLI without marker or report and follows foreground switches rather than stale reports", async () => {
  const resumed = "12aa83d8-48bc-41f2-a498-7055c5c44a03";
  const forked = "12aa83d8-48bc-41f2-a498-7055c5c44a04";
  for (const id of [resumed, forked]) {
    mkdirSync(join(home, "session-state", id), { recursive: true });
    writeFileSync(file(id), fixture(id, id) + Array.from({ length: 55 }, () => event("user.message", { content: id })).join("") + event("assistant.message", {
      toolRequests: [{ toolCallId: `call-${id}`, name: "shell", arguments: {} }],
    }) + event("tool.execution_complete", { toolCallId: `call-${id}`, result: { content: `output-${id} `.repeat(600) } }));
  }
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-lifecycle" });
  const current = created.root_pane.pane_id;
  try {
    await startFixture(current, resumed, `--resume=${resumed} --lifecycle`);
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    let lastResponse = "";
    const read = async () => {
      const response = await fetch(url);
      const body = await response.json();
      lastResponse = `${response.status} ${JSON.stringify(body)}`;
      if (response.status !== 200) return null;
      return body as {
        source: string; turns: { parts: { text?: string; output_ref?: string }[] }[]; cursor?: string; history_id?: string;
      };
    };
    // A switch may answer scrollback, or 409 if ownership changes during the read.
    // Neither is the transcript this waits for; keep the response for timeout diagnostics.
    const waitForTranscript = async (text: string, previousHistory?: string) => {
      for (const deadline = Date.now() + 5000;;) {
        const body = await read();
        if (body?.source === "copilot-transcript" && body.turns[0]?.parts[0]?.text === text
          && (previousHistory === undefined || body.history_id !== previousHistory)) return body;
        if (Date.now() > deadline) throw new Error(`Copilot transcript ${text} was not selected: ${lastResponse}`);
        await Bun.sleep(50);
      }
    };
    const initial = await waitForTranscript(resumed);
    expect(initial.source).toBe("copilot-transcript");
    expect(initial.turns[0]?.parts[0]?.text).toBe(resumed);
    expect(initial.history_id).not.toStartWith("unwritten:");
    const oldCursor = initial.cursor!;
    expect(oldCursor).toBeDefined();
    const oldRef = initial.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(oldRef).toBeDefined();
    expect((await fetch(`${url}&from=${encodeURIComponent(oldCursor)}`)).status).toBe(200);
    expect((await fetch(`${url}&before=${encodeURIComponent(oldCursor)}`)).status).toBe(200);
    const outputUrl = (ref: string) => `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: current, ref })}`;
    expect((await fetch(outputUrl(oldRef!))).status).toBe(200);
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-log-peer" });
    try {
      const peer = duplicate.root_pane.pane_id;
      await startFixture(peer, resumed, `--resume=${resumed} --lifecycle`);
      // herdr names the peer before it logs its Registering line: until then the first pane still owns the log
      const peerUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(peer)}`;
      for (const [who, target] of [["the first pane", url], ["the peer", peerUrl]] as const) {
        for (const deadline = Date.now() + 5000;;) {
          const response = await fetch(target);
          const body = await response.json() as { source?: string };
          if (response.status === 200 && body.source === "scrollback") break;
          if (Date.now() > deadline) throw new Error(`${who} did not fail closed for a shared log: ${response.status} ${JSON.stringify(body)}`);
          await Bun.sleep(50);
        }
      }
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    await waitForTranscript(resumed);
    await herdrRpc("pane.report_agent_session", { pane_id: current, agent: "copilot", source: "herdr:copilot",
      seq: Date.now() * 1000, agent_session_id: resumed });
    await herdrRpc("pane.send_text", { pane_id: current, text: `:hold ${resumed}\n:hold ${forked}\n:switch ${forked}\n` });
    await waitForTranscript(forked);
    expect((await fetch(`${url}&from=${encodeURIComponent(initial.cursor ?? initial.history_id!)}`)).status).toBe(409);
    const staleTool = new URLSearchParams({ pane_id: current, ref: `call-${resumed}` });
    expect((await fetch(`http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${staleTool}`)).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:switch ${resumed}\n` });
    const returned = await waitForTranscript(resumed);
    expect(returned.history_id).not.toBe(initial.history_id);
    expect((await fetch(`${url}&from=${encodeURIComponent(oldCursor)}`)).status).toBe(409);
    expect((await fetch(`${url}&before=${encodeURIComponent(oldCursor)}`)).status).toBe(409);
    expect((await fetch(outputUrl(oldRef!))).status).toBe(404);
    const newRef = returned.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(newRef).toBeDefined();
    expect(newRef).not.toBe(oldRef);
    expect((await fetch(outputUrl(newRef!))).status).toBe(200);
    expect((await fetch(`${url}&before=${encodeURIComponent(returned.cursor!)}`)).status).toBe(200);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:switch ${forked}\n:switch ${resumed}\n` });
    const unobserved = await waitForTranscript(resumed, returned.history_id);
    expect((await fetch(`${url}&before=${encodeURIComponent(returned.cursor!)}`)).status).toBe(409);
    expect((await fetch(outputUrl(newRef!))).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: ":unregister\n" });
    for (const deadline = Date.now() + 5000;;) {
      if ((await read())?.source === "scrollback") break;
      if (Date.now() > deadline) throw new Error(`unregistered foreground did not fail closed: ${lastResponse}`);
      await Bun.sleep(50);
    }
    expect((await fetch(`${url}&from=${encodeURIComponent(unobserved.cursor!)}`)).status).toBe(409);
    const latestRef = unobserved.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(latestRef).toBeDefined();
    expect((await fetch(outputUrl(latestRef!))).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:register ${forked}\n` });
    await waitForTranscript(forked);
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 15_000);

it.skipIf(process.platform !== "linux")("never mistakes an explicitly resumed launch without current evidence for a fresh empty chat", async () => {
  const resumed = "12aa83d8-48bc-41f2-a498-7055c5c44a05";
  mkdirSync(join(home, "session-state", resumed), { recursive: true });
  writeFileSync(file(resumed), fixture(resumed, "existing history"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-no-proof" });
  const current = created.root_pane.pane_id;
  try {
    await startFixture(current, resumed, `--resume=${resumed} --no-proof`);
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    expect((await (await fetch(url)).json()).source).toBe("scrollback");
    expect((await fetch(`${url}&from=stale`)).status).toBe(409);
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
});

it.skipIf(process.platform !== "linux")("shows the pictures a recorded Copilot session interned and serves each from that session only", async () => {
  const pictured = "12aa83d8-48bc-41f2-a498-7055c5c44a07";
  const recorded = fs.readFileSync(new URL("./fixtures/copilot-pictures-1.0.105-events.jsonl", import.meta.url), "utf8");
  const red = "copilot:db47bba5fe6470a832370fa0ca3cbfd9194dd1e36eaa3d67fdd33bea01d4b66a";
  const blue = "copilot:c75fe07b33afb7b182fa53cd500727a7cfa1699443a17d87d053d6536ad65438";
  mkdirSync(join(home, "session-state", pictured), { recursive: true });
  // the recorded session under this test's id; a prompt that is only the red picture again, as Copilot names an asset it already holds
  writeFileSync(file(pictured), recorded.replace(/"sessionId":"[0-9a-f-]{36}"/, `"sessionId":"${pictured}"`)
    + event("user.message", { content: "", attachments: [{ type: "blob", mimeType: "image/png", assetId: `sha256:${red.slice(8)}`, byteLength: 140 }] }));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-pictures" });
  const current = created.root_pane.pane_id;
  try {
    await startFixture(current, pictured);
    await herdrRpc("pane.report_agent_session", { pane_id: current, agent: "copilot", source: "herdr:copilot", seq: Date.now() * 1000, agent_session_id: pictured });
    const page = await (await fetch(`http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`)).json() as { source: string; turns: { role: string; parts: { kind: string; media_type?: string; ref?: string; images?: { ref: string }[] }[] }[] };
    expect(page.source).toBe("copilot-transcript");
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(page.turns[0]!.parts.map((part) => part.ref ?? part.kind)).toEqual(["text", red]);
    expect(page.turns[1]!.parts.find((part) => part.kind === "tool")?.images?.map((image) => image.ref)).toEqual([blue]);
    expect(page.turns[2]!.parts).toEqual([{ kind: "image", media_type: "image/png", ref: red }]);
    const image = (ref: string, pane = current) => fetch(`http://127.0.0.1:${app.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: pane, ref })}`);
    for (const ref of [red, blue]) {
      const response = await image(ref);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
      expect(new Bun.CryptoHasher("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex")).toBe(ref.slice(8));
    }
    expect((await image(`copilot:${"0".repeat(64)}`)).status).toBe(404);
    // another pane's Copilot session never had these pictures: the ref names no picture there
    expect((await image(red, pane)).status).toBe(404);
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 15_000);

it.skipIf(process.platform !== "linux")("binds a direct Copilot handoff only while its parent log, child hold and report agree", () => handoffTest(true), 25_000);
it.skipIf(process.platform !== "linux")("binds a direct Copilot handoff whose parent log starts with its unregister", () => handoffTest(false), 25_000);
