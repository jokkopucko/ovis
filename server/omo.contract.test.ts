import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { labelOmoPanes, paneTranscript } from "./conversation.ts";
import { isOmoProcess, omoPanes, omoSessionForPane, omoTranscriptForPane, omoTranscriptsOfCwd, type ProcessInfo } from "./omo.ts";
import { createServer } from "./index.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { startShellAgent } from "./shell-agent.ts";
import { processStartedAt } from "./process-start.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-binding-"));
const workspaces: string[] = [];
const script = join(root, "omo");
writeFileSync(script, "setInterval(() => {}, 1000);\n");
const dir = join(root, ".omo", "agent", "sessions", `-${root.replaceAll("/", "-")}--`);
mkdirSync(dir, { recursive: true });
afterAll(async () => {
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

async function waitForProcess(paneId: string, marker: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const info = await herdrRpc<NonNullable<ProcessInfo>>("pane.process_info", { pane_id: paneId });
    const processes = info.process_info?.foreground_processes ?? [];
    const process = processes.find((process) => process.argv?.includes(marker));
    if (process) return { process, processes };
    if (Date.now() >= deadline) {
      throw new Error(`test process ${marker} did not appear in pane ${paneId}; last process info: ${JSON.stringify(info)}`);
    }
    await Bun.sleep(50);
  }
}

async function launch(command: string, marker: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-omo-binding" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${command}\n` });
  await waitForProcess(paneId, marker);
  return paneId;
}
const pane = (id?: string) => launch(`${process.execPath} ${script}${id ? ` --session-id ${id}` : ""}`, script);
const read = async (paneId: string) => omoTranscriptForPane(paneId, root, (await sessionSnapshot()).panes, root);
/**
 * What a pane reads once herdr's process info shows the omo just launched: launch() returns on one process-info
 * read that has it, and a later snapshot can still omit it, so a read right after a launch may see one omo fewer.
 */
const readsAs = async (paneId: string, want: string | null): Promise<string | null> => {
  const deadline = Date.now() + 5_000;
  let got = await read(paneId);
  while (got !== want && Date.now() < deadline) {
    await Bun.sleep(50);
    got = await read(paneId);
  }
  return got;
};
const session = (id: string, timestamp = new Date().toISOString()) => {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd: root, timestamp }) + "\n");
  return path;
};

it("labels a running omo pane when herdr supplies no agent kind", async () => {
  const paneId = await pane();
  const snapshot = await sessionSnapshot();
  try {
    expect(snapshot.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();

    const deadline = Date.now() + 5_000;
    let labelled = await labelOmoPanes(snapshot);
    while (labelled.panes.find((entry) => entry.pane_id === paneId)?.agent !== "omo") {
      if (Date.now() >= deadline) throw new Error("test omo process was not labelled");
      await Bun.sleep(50);
      labelled = await labelOmoPanes(snapshot);
    }

    expect(labelled.panes.find((entry) => entry.pane_id === paneId)?.agent).toBe("omo");
    expect(snapshot.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();
  } finally {
    const workspaceId = workspaces.pop();
    if (workspaceId) await workspaceClose(workspaceId);
  }
});

it("leaves a shell labelled OmO DAG without an agent kind", async () => {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-omo-shell" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  const snapshot = await sessionSnapshot();
  const titled = { ...snapshot, panes: snapshot.panes.map((entry) =>
    entry.pane_id === paneId ? { ...entry, terminal_title: "OmO DAG" } : entry) };

  try {
    const labelled = await labelOmoPanes(titled);

    expect(labelled.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();
  } finally {
    workspaces.pop();
    await workspaceClose(created.workspace.workspace_id);
  }
});

it("uses live process evidence and stops cwd inference as soon as a second omo shares it", async () => {
  const first = await pane();
  const fresh = session("fresh-session");
  expect(await read(first)).toBe(fresh);
  const resumed = session("resumed-session", "2020-01-01T00:00:00Z");
  const second = await pane("resumed-session");
  expect(await readsAs(first, null)).toBeNull();
  expect(await read(second)).toBe(resumed);
  const duplicate = await pane("resumed-session");
  expect(await readsAs(second, null)).toBeNull();
  expect(await read(duplicate)).toBeNull();
});

it("starts omo through the pane's shell and waits until omo is its foreground process", async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-omo-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  const started = await shell();
  await startShellAgent("omo", started, ["it's one arg"], { command: `${process.execPath} ${script}` });
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: started });
  expect(info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []))?.argv?.slice(-1)).toEqual(["it's one arg"]);
  await expect(startShellAgent("omo", await shell(), [], { command: "true", timeoutMs: 1500 })).rejects.toThrow("omo did not start");
});

// omo keeps no descriptor on its session file; it publishes a holder record instead
const hold = async (paneId: string, id: string, store = dir, marker = script) => {
  const { process: { pid } } = await waitForProcess(paneId, marker);
  const holders = join(store, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs: Math.floor(processStartedAt(pid)! / 1000) * 1000, cwd: root }));
};

it("binds each omo pane in a shared cwd to the session its process holds", async () => {
  const first = await pane();
  const second = await pane();
  const afterNew = await pane("launch-session");
  const reportedBefore = await pane();
  const resumed = session("held-resumed", "2020-01-01T00:00:00Z");
  const fresh = session("held-fresh");
  session("launch-session");
  const replaced = session("held-after-new");
  const reported = session("herdr-reported");
  const heldSinceReport = session("held-since-report");
  await hold(first, "held-resumed");
  await hold(second, "held-fresh");
  await hold(afterNew, "held-after-new");
  await hold(reportedBefore, "held-since-report");
  expect(await read(first)).toBe(resumed);
  expect(await read(second)).toBe(fresh);
  expect(await read(afterNew)).toBe(replaced);
  const panes = (await sessionSnapshot()).panes.map((entry) =>
    entry.pane_id === reportedBefore ? { ...entry, agent_session: { agent: "omo", kind: "path", source: "herdr:omo", value: reported } } : entry);
  expect(await omoTranscriptForPane(reportedBefore, root, panes, root)).toBe(heldSinceReport);
});
it("tells a held session omo has not written yet from an older one", async () => {
  // omo writes the file with the first prompt; a launch id can name the session before /new
  const started = await pane();
  const afterNew = await pane("launched-before-new");
  session("launched-before-new");
  await hold(started, "unwritten-first");
  await hold(afterNew, "unwritten-after-new");
  writeFileSync(join(dir, "unwritten-first-copy.jsonl"), JSON.stringify({ type: "session", id: "copied", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const panes = (await sessionSnapshot()).panes;
  expect(await omoSessionForPane(started, root, panes, root)).toEqual({ path: null, pending: "unwritten-first" });
  expect(await omoSessionForPane(afterNew, root, panes, root)).toEqual({ path: null, pending: "unwritten-after-new" });
  const written = session("unwritten-first");
  expect(await omoSessionForPane(started, root, panes, root)).toEqual({ path: realpathSync(written), pending: null, identity: expect.any(String) });
});

it("serves a held omo session as an empty conversation until its file is written", async () => {
  const paneId = await pane();
  await hold(paneId, "unwritten-http");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "server-state"), machines: false });
  const home = process.env["HOME"];
  process.env["HOME"] = root;
  const read = (query = "") => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}${query}`);
  try {
    const pending = await read();
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ source: "omo-transcript", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: "unwritten:unwritten-http", server_time: expect.any(String) });
    expect((await read("&before=stale:0")).status).toBe(409);
    writeFileSync(join(dir, "2026-10-03T00-00-00-000Z_unwritten-http.jsonl"), [
      { type: "session", id: "unwritten-http", cwd: root, timestamp: new Date().toISOString() },
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "first message" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const written = await (await read()).json() as ConversationResponse;
    expect(written.source).toBe("omo-transcript");
    expect(written.history_id).not.toBe("unwritten:unwritten-http");
    expect(written.turns.map((turn) => turn.role)).toEqual(["user"]);
  } finally {
    process.env["HOME"] = home;
    server.stop();
  }
});

it("serves the picture an omo tool showed through the pane's image endpoint (#3420)", async () => {
  const paneId = await pane();
  await hold(paneId, "pictured-http");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const at = new Date().toISOString();
  writeFileSync(join(dir, "2026-10-04T00-00-00-000Z_pictured-http.jsonl"), [
    { type: "session", id: "pictured-http", cwd: root, timestamp: at },
    { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "show it" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "display(png)" } }] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: at, message: { role: "toolResult", toolCallId: "call-eval", toolName: "eval", content: [{ type: "text", text: "shown" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "server-state-pictured"), machines: false });
  const home = process.env["HOME"];
  process.env["HOME"] = root;
  const url = (route: string, query: Record<string, string>) => `http://127.0.0.1:${server.port}${route}?${new URLSearchParams({ pane_id: paneId, ...query })}`;
  try {
    const page = await (await fetch(url("/api/pane/conversation", {}))).json() as ConversationResponse;
    const tool = page.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
    expect(tool !== undefined && tool.kind === "tool" && tool.images).toEqual([{ media_type: "image/png", ref: "pi:call-eval:0" }]);
    const image = await fetch(url("/api/pane/conversation/image", { ref: "pi:call-eval:0" }));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    expect((await fetch(url("/api/pane/conversation/image", { ref: "pi:call-eval:1" }))).status).toBe(404);
  } finally {
    process.env["HOME"] = home;
    server.stop();
  }
});

// open files are read from /proc, which macOS does not have
it.skipIf(process.platform !== "linux")("ignores the background task logs omo holds open outside its session store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-omo-task-log-"));
  const store = join(cwd, ".omo", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  const logs = join(cwd, ".omo", "senpi-task", "logs");
  mkdirSync(store, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const holder = join(cwd, "omo");
  writeFileSync(holder, "require('node:fs').openSync(process.argv[2], 'a');\nsetInterval(() => {}, 1000);\n");
  const created = await workspaceCreate({ cwd, label: "ovis-test-omo-task-log" });
  try {
    const paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${holder} ${join(logs, "st_task.jsonl")}\n` });
    let held = false;
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
      const omo = info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []));
      if (omo) held = readdirSync(`/proc/${omo.pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${omo.pid}/fd/${fd}`).endsWith("st_task.jsonl"); } catch { return false; } });
      if (!held) await Bun.sleep(50);
    }
    expect(held).toBe(true);
    const path = join(store, "task-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "task-session", cwd, timestamp: new Date().toISOString() }) + "\n");
    expect(await omoTranscriptForPane(paneId, cwd, (await sessionSnapshot()).panes, cwd)).toBe(realpathSync(path));
  } finally {
    await workspaceClose(created.workspace.workspace_id);
    rmSync(cwd, { recursive: true, force: true });
  }
});

// a custom launcher's own name says nothing about omo, and a process's environment at
// exec is read from /proc/<pid>/environ: both halves of that contract are Linux-only
it.skipIf(process.platform !== "linux")("recognizes a custom launcher only by verified holders in an env-named store", async () => {
  const launcher = join(root, "team-ai");
  writeFileSync(launcher, "setInterval(() => {}, 1000);\n");
  const agentDir = join(root, "custom-agent");
  const store = join(agentDir, "sessions", `-${root.replaceAll("/", "-")}--`);
  const paneId = await launch(`OMO_CODING_AGENT_DIR=${agentDir} ${process.execPath} ${launcher}`, launcher);
  expect(await omoSessionForPane(paneId, root, (await sessionSnapshot()).panes, root)).toEqual({ path: null, pending: null });
  expect((await labelOmoPanes(await sessionSnapshot())).panes.find((pane) => pane.pane_id === paneId)?.agent).toBeUndefined();
  await hold(paneId, "custom-pending", store, launcher);
  expect(await omoSessionForPane(paneId, root, (await sessionSnapshot()).panes, root)).toEqual({ path: null, pending: "custom-pending" });
  expect((await labelOmoPanes(await sessionSnapshot())).panes.find((pane) => pane.pane_id === paneId)?.agent).toBe("omo");
  const written = join(store, "2026-10-03T00-00-00-000Z_custom-pending.jsonl");
  writeFileSync(written, JSON.stringify({ type: "session", id: "custom-pending", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  expect(await omoTranscriptForPane(paneId, root, (await sessionSnapshot()).panes, root)).toBe(realpathSync(written));
  const snapshot = await sessionSnapshot();
  const { process: custom, processes } = await waitForProcess(paneId, launcher);
  expect(readlinkSync(`/proc/${custom.pid}/cwd`)).toBe(root);
  // Older process-info responses omit cwd; both pane directory fields can be stale.
  const withoutCwd = { process_info: { foreground_processes: processes.map(({ pid, argv }) => ({ pid, argv })) } };
  const stale = snapshot.panes.filter((entry) => entry.pane_id === paneId).map((entry) =>
    ({ ...entry, cwd: join(root, "stale-pane"), foreground_cwd: join(root, "stale-foreground") }));
  const resolved = omoTranscriptsOfCwd(root, stale, new Map([[paneId, withoutCwd]]), root).get(paneId);
  expect(resolved?.path).toBe(realpathSync(written));
  expect(resolved?.pending).toBeNull();
  for (const agent of ["codex", "devin", "gjc"]) {
    const relabelled = { ...snapshot, panes: snapshot.panes.map((entry) => entry.pane_id === paneId ? { ...entry, agent } : entry) };
    expect((await omoPanes(relabelled.panes)).get(paneId)?.path).toBe(realpathSync(written));
    expect((await paneTranscript(paneId, undefined, relabelled)).source).toBe("omo-transcript");
  }

});

it.skipIf(process.platform !== "linux")("recognizes a custom launcher in the default store and refuses a senpi-only one", async () => {
  const plain = join(root, "plain-runner");
  writeFileSync(plain, "setInterval(() => {}, 1000);\n");
  const paneId = await launch(`env -u OMO_CODING_AGENT_DIR -u SENPI_CODING_AGENT_DIR -u PI_CODING_AGENT_DIR ${process.execPath} ${plain}`, plain);
  await hold(paneId, "default-held", dir, plain);
  const path = session("default-held", "2020-01-01T00:00:00Z");
  expect(await omoTranscriptForPane(paneId, root, (await sessionSnapshot()).panes, root)).toBe(realpathSync(path));
  const senpi = join(root, "senpi-runner");
  writeFileSync(senpi, "setInterval(() => {}, 1000);\n");
  const otherDir = join(root, "senpi-state", "sessions", `-${root.replaceAll("/", "-")}--`);
  const paneId2 = await launch(`env -u OMO_CODING_AGENT_DIR -u PI_CODING_AGENT_DIR SENPI_CODING_AGENT_DIR=${join(root, "senpi-state")} ${process.execPath} ${senpi}`, senpi);
  await hold(paneId2, "senpi-held", otherDir, senpi);
  expect(await omoSessionForPane(paneId2, root, (await sessionSnapshot()).panes, root)).toEqual({ path: null, pending: null });
});
