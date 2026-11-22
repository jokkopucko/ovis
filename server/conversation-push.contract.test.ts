import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ConversationResponse, ServerMessage } from "../shared/protocol.ts";
import { ConversationMonitor } from "./conversation-monitor.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";

type TestBridge = { port: number; stop: () => void };
type ConversationChanged = Extract<ServerMessage, { type: "conversation-changed" }>;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

class TranscriptSocket {
  readonly frames: ServerMessage[] = [];
  readonly ws: WebSocket;

  constructor(bridge: TestBridge) {
    this.ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    this.ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as ServerMessage));
  }

  async open(): Promise<void> {
    await until(() => this.frames.some((frame) => frame.type === "snapshot"), "socket snapshot");
  }

  send(message: ClientMessage): void { this.ws.send(JSON.stringify(message)); }

  async waitFor(predicate: (frame: ServerMessage) => boolean, after = 0): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await until(() => {
      found = this.frames.find((frame, index) => index >= after && predicate(frame));
      return found !== undefined;
    }, "expected websocket frame");
    return found!;
  }

  async changed(paneId: string, after = 0): Promise<ConversationChanged> {
    return await this.waitFor((frame) => frame.type === "conversation-changed" && frame.pane_id === paneId, after) as ConversationChanged;
  }
}

describe("native conversation invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-conversation-push-"));
  // the omp store sits under a temporary HOME (as in omp.contract.test.ts), never the user's own
  const originalHome = process.env["HOME"];
  const sessionStore = join(root, ".omp", "agent", "sessions");
  mkdirSync(sessionStore, { recursive: true, mode: 0o700 });
  const store = mkdtempSync(join(sessionStore, "herdr-conversation-push-"));
  const path = join(store, "first.jsonl");
  const replacement = join(store, "second.jsonl");
  const bridges: TestBridge[] = [];
  const sockets: TranscriptSocket[] = [];
  const monitors = new Map<string, ConversationMonitor>();
  let bridge: TestBridge;
  let workspaceId: string;
  let paneId: string;
  let reportSeq = Date.now() * 1000;
  const originalWatch = ConversationMonitor.prototype.watch;
  const watched = spyOn(ConversationMonitor.prototype, "watch").mockImplementation(function (this: ConversationMonitor, id: string) {
    monitors.set(id, this);
    originalWatch.call(this, id);
  });

  function transcript(answer = "first answer", id = "01a0c7a1-56d9-7e20-9f08-f7a2d973bcfe"): string {
    return `${[
      { type: "session", version: 3, id, cwd: root },
      { type: "model_change", modelId: "initial-model" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Watch native changes" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  }

  async function report(file = path): Promise<void> {
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:omp", agent: "omp", seq: ++reportSeq, agent_session_path: file, session_start_source: "startup" });
    const binding = await herdrRpc<{ agent: { agent_session?: { kind: string; value: string } } }>("agent.get", { target: paneId });
    expect(binding.agent.agent_session).toMatchObject({ kind: "path", value: file });
  }

  async function connect(target = bridge): Promise<TranscriptSocket> {
    const socket = new TranscriptSocket(target);
    sockets.push(socket);
    await socket.open();
    return socket;
  }

  async function read(target = bridge): Promise<ConversationResponse> {
    const response = await fetch(`http://127.0.0.1:${target.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    expect(response.status).toBe(200);
    return await response.json() as ConversationResponse;
  }

  function attach(socket: TranscriptSocket): void {
    socket.send({ type: "attach", pane_id: paneId, cols: 80, rows: 24, keep_size: true });
  }

  function watch(socket: TranscriptSocket, enabled = true, id = paneId): void {
    socket.send({ type: "conversation-watch", pane_id: id, enabled });
  }

  async function barrier(socket: TranscriptSocket, mode: "interact" | "observe" = "interact"): Promise<void> {
    const after = socket.frames.length;
    socket.send({ type: "role", mode });
    await socket.waitFor((frame) => frame.type === "role-ack" && frame.mode === mode, after);
  }

  beforeAll(async () => {
    forgetTranscriptState();
    writeFileSync(path, transcript());
    mkdirSync(join(root, "bin"));
    const executable = join(root, "bin", "omp");
    writeFileSync(executable, "#!/bin/sh\nsleep 600\n");
    chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-conversation-push" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable}\n` });
    await until(async () => (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "omp", "owned omp process detected");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++reportSeq });
    await report();
    process.env["HOME"] = root;
    bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
    bridges.push(bridge);
    expect((await read()).source).toBe("omp-transcript");
  });

  afterAll(async () => {
    for (const socket of sockets) socket.ws.close();
    for (const server of bridges) server.stop();
    watched.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (workspaceId) await workspaceClose(workspaceId);
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("does not monitor terminal-only attachments and releases disabled interest without detaching", async () => {
    const terminal = await connect();
    const reader = await connect();
    const watchCalls = () => {
      let count = 0;
      for (const [id] of watched.mock.calls) if (id === paneId) count += 1;
      return count;
    };
    const before = watchCalls();
    attach(terminal);
    await terminal.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId);
    await barrier(terminal);
    expect(watchCalls()).toBe(before);
    expect(terminal.frames.some((frame) => frame.type === "conversation-changed")).toBe(false);

    attach(reader);
    await reader.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    watch(reader);
    await reader.changed(paneId);
    const monitor = monitors.get(paneId)!;
    expect(monitor.size).toBe(1);
    const afterDisable = reader.frames.length;
    watch(reader, false);
    await barrier(reader, "observe");
    await reader.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, afterDisable);
    expect(monitor.size).toBe(0);

    const disabledCalls = watchCalls();
    attach(reader);
    await barrier(reader);
    expect(watchCalls()).toBe(disabledCalls);
    expect(monitor.size).toBe(0);
    const afterTerminal = terminal.frames.length;
    const afterReader = reader.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "interest-model" })}\n`);
    watch(reader);
    await reader.changed(paneId, afterReader);
    expect((await read()).metadata?.model).toBe("interest-model");
    expect(terminal.frames.slice(afterTerminal).some((frame) => frame.type === "conversation-changed")).toBe(false);

    reader.ws.close();
    await until(() => monitor.size === 0, "closing the only interested client kept no monitor");
    const after = terminal.frames.length;
    await barrier(terminal, "observe");
    await terminal.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, after);
    watch(terminal);
    await terminal.changed(paneId);
    watch(terminal, false);
    await barrier(terminal, "observe");
    expect(monitor.size).toBe(0);
    terminal.ws.close();
  }, 30_000);

  it("rejects malformed interest and unattached enables in-band without closing the socket", async () => {
    const socket = await connect();
    const snapshot = socket.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features?.includes("conversation-watch")).toBe(true);
    for (const fields of [
      { pane_id: paneId },
      { pane_id: paneId, enabled: "true" },
      { pane_id: paneId, enabled: null },
      { enabled: true },
      { pane_id: 7, enabled: true },
      { pane_id: "", enabled: true },
      { pane_id: "   ", enabled: false },
    ]) {
      const after = socket.frames.length;
      socket.ws.send(JSON.stringify({ type: "conversation-watch", ...fields }));
      await socket.waitFor((frame) => frame.type === "error" && frame.code === "invalid_conversation_watch", after);
    }
    const after = socket.frames.length;
    watch(socket);
    await socket.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", after);
    watch(socket, false);
    await barrier(socket, "observe");
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    socket.ws.close();
  });

  it("follows a pane's conversation without attaching it, through the pane's attach and detach, until a detached disable or close", async () => {
    const socket = await connect();
    const snapshot = socket.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features?.includes("conversation-watch-detached")).toBe(true);
    const follow = (target: TranscriptSocket, enabled: boolean, id = paneId): void => target.send({ type: "conversation-watch", pane_id: id, enabled, detached: true });
    follow(socket, true);
    await socket.changed(paneId);
    const monitor = monitors.get(paneId)!;
    expect(monitor.size).toBe(1);
    let after = socket.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "detached-model" })}\n`);
    await socket.changed(paneId, after);
    expect((await read()).metadata?.model).toBe("detached-model");

    attach(socket);
    await socket.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    watch(socket, false);
    socket.send({ type: "detach", pane_id: paneId });
    await barrier(socket);
    expect(monitor.size).toBe(1);
    after = socket.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "still-followed-model" })}\n`);
    await socket.changed(paneId, after);
    expect(socket.frames.some((frame) => frame.type === "error")).toBe(false);

    follow(socket, false);
    await barrier(socket);
    expect(monitor.size).toBe(0);
    after = socket.frames.length;
    follow(socket, true);
    await socket.changed(paneId, after);
    socket.ws.close();
    await until(() => monitor.size === 0, "closing the connection released its detached interest");

    const crowded = await connect();
    for (let i = 0; i < 32; i++) follow(crowded, true, `${paneId}-detached-${i}`);
    after = crowded.frames.length;
    follow(crowded, true, `${paneId}-detached-32`);
    await crowded.waitFor((frame) => frame.type === "error" && frame.code === "too_many_conversation_watches", after);
    after = crowded.frames.length;
    crowded.ws.send(JSON.stringify({ type: "conversation-watch", pane_id: paneId, enabled: true, detached: "yes" }));
    await crowded.waitFor((frame) => frame.type === "error" && frame.code === "invalid_conversation_watch", after);
    crowded.ws.close();
    await until(() => monitor.size === 0, "closing the crowded connection released every detached interest");
  }, 30_000);

  it("shares interested pane monitors, notices metadata/tear/replacement/missing/new-session writes and releases detach/close claims", async () => {
    const first = await connect();
    const second = await connect();
    const third = await connect();
    const stranger = await connect();
    attach(first);
    watch(first);
    const initial = await first.changed(paneId);
    expect(JSON.stringify(initial)).not.toContain(store);
    attach(second);
    await barrier(second, "observe");
    watch(second);
    await barrier(second, "observe");
    attach(third);
    watch(third);
    await barrier(third, "observe");
    attach(stranger);
    await stranger.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    await second.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId);
    const monitor = monitors.get(paneId)!;
    expect(monitor.size).toBe(1);
    const original = await read();
    expect(original.source).toBe("omp-transcript");

    let afterFirst = first.frames.length;
    let afterSecond = second.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "changed-model" })}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" })}\n`);
    const metadataChange = await first.changed(paneId, afterFirst);
    expect(metadataChange.signature).not.toBe(initial.signature);
    expect((await second.changed(paneId, afterSecond)).signature).toBe(metadataChange.signature);
    const metadata = await read();
    expect(metadata.metadata).toEqual({ model: "changed-model", reasoning_effort: "low" });
    expect(metadata.turns).toEqual(original.turns);

    afterFirst = first.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "appended native answer" }] } })}\n`);
    await first.changed(paneId, afterFirst);
    expect(JSON.stringify((await read()).turns)).toContain("appended native answer");

    afterFirst = first.frames.length;
    appendFileSync(path, '{"type":"model_change","modelId":"torn-model"');
    await first.changed(paneId, afterFirst);
    expect((await read()).metadata?.model).toBe("changed-model");
    afterFirst = first.frames.length;
    appendFileSync(path, `}\n${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" })}\n`);
    await first.changed(paneId, afterFirst);
    expect((await read()).metadata).toEqual({ model: "torn-model", reasoning_effort: "medium" });

    afterFirst = first.frames.length;
    writeFileSync(path, transcript());
    await first.changed(paneId, afterFirst);
    const truncated = await read();
    expect(truncated.history_id).not.toBe(original.history_id);
    afterFirst = first.frames.length;
    expect(Buffer.byteLength(transcript("other answer"))).toBe(Buffer.byteLength(transcript()));
    writeFileSync(`${path}.new`, transcript("other answer"));
    renameSync(`${path}.new`, path);
    await first.changed(paneId, afterFirst);
    const replaced = await read();
    expect(replaced.history_id).not.toBe(truncated.history_id);
    expect(JSON.stringify(replaced.turns)).toContain("other answer");

    afterFirst = first.frames.length;
    rmSync(path);
    await first.changed(paneId, afterFirst);
    expect(await read()).toEqual({ source: "scrollback", turns: [], unavailable: "unreadable" });
    afterFirst = first.frames.length;
    writeFileSync(path, transcript());
    await first.changed(paneId, afterFirst);
    await until(async () => (await read()).source === "omp-transcript", "the missing transcript reappeared");

    afterFirst = first.frames.length;
    writeFileSync(replacement, transcript("new session answer", "01a0c7a1-56d9-7e20-9f08-f7a2d973bcfd"));
    await report(replacement);
    await first.changed(paneId, afterFirst);
    expect(JSON.stringify((await read()).turns)).toContain("new session answer");

    first.send({ type: "detach", pane_id: paneId });
    await barrier(first, "observe");
    expect(monitor.size).toBe(1);
    afterFirst = first.frames.length;
    afterSecond = second.frames.length;
    const afterThird = third.frames.length;
    appendFileSync(replacement, `${JSON.stringify({ type: "model_change", modelId: "last-model" })}\n`);
    const finalChange = await second.changed(paneId, afterSecond);
    expect((await third.changed(paneId, afterThird)).signature).toBe(finalChange.signature);
    expect(first.frames.slice(afterFirst).some((frame) => frame.type === "conversation-changed")).toBe(false);
    expect(stranger.frames.some((frame) => frame.type === "conversation-changed")).toBe(false);
    second.ws.close();
    await until(() => second.ws.readyState === WebSocket.CLOSED, "one interested client closed");
    expect(monitor.size).toBe(1);
    third.send({ type: "detach", pane_id: paneId });
    await barrier(third, "observe");
    await until(() => monitor.size === 0, "the last interest detached while terminal-only clients stayed");
    const beforeReattach = first.frames.length;
    attach(first);
    await first.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId, beforeReattach);
    expect(monitor.size).toBe(0);
    first.ws.close();
    stranger.ws.close();
    third.ws.close();
  }, 60_000);

  it("discovers the first native file written after a pane was attached", async () => {
    const unwritten = join(store, "not-yet-written.jsonl");
    await report(unwritten);
    const socket = await connect();
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    const initialConversation = await read();
    expect(initialConversation.turns).toEqual([]);
    const after = socket.frames.length;
    writeFileSync(unwritten, transcript("the first newly written answer"));
    await socket.changed(paneId, after);
    const writtenConversation = await read();
    expect(JSON.stringify(writtenConversation.turns)).toContain("the first newly written answer");
    expect(writtenConversation.history_id).not.toBe(initialConversation.history_id);
    const monitor = monitors.get(paneId)!;
    socket.ws.close();
    await until(() => monitor.size === 0, "new-file monitor released after close");
    await report();
  }, 25_000);

  it("releases failed attaches, disabled/detached/closed pending interest, and stop without reviving a monitor", async () => {
    writeFileSync(path, transcript());
    await report();
    const gate = Promise.withResolvers<boolean>();
    const pending = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "pending"), sidecar: false, terminalAttach: () => gate.promise });
    bridges.push(pending);
    const socket = await connect(pending);
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    const detachedMonitor = monitors.get(paneId)!;
    socket.send({ type: "detach", pane_id: paneId });
    await barrier(socket, "observe");
    expect(detachedMonitor.size).toBe(0);
    const after = socket.frames.length;
    attach(socket);
    watch(socket);
    await socket.changed(paneId, after);
    socket.ws.close();
    await until(() => detachedMonitor.size === 0, "close cancelled the pending native monitor");
    const survivor = await connect(pending);
    attach(survivor);
    watch(survivor);
    await survivor.changed(paneId);
    watch(survivor, false);
    await barrier(survivor);
    expect(detachedMonitor.size).toBe(0);
    const beforeCompletion = survivor.frames.length;
    gate.resolve(false);
    await survivor.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId);
    expect(detachedMonitor.size).toBe(0);
    expect(survivor.frames.slice(beforeCompletion).some((frame) => frame.type === "conversation-changed")).toBe(false);
    watch(survivor);
    await survivor.changed(paneId, beforeCompletion);
    watch(survivor, false);
    await barrier(survivor);
    expect(detachedMonitor.size).toBe(0);
    survivor.ws.close();
    pending.stop();

    const failedGate = Promise.withResolvers<boolean>();
    const failing = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "failing"), sidecar: false, terminalAttach: () => failedGate.promise });
    bridges.push(failing);
    const failed = await connect(failing);
    const missingPane = "w999999:p999999";
    failed.send({ type: "attach", pane_id: missingPane, cols: 80, rows: 24 });
    watch(failed, true, missingPane);
    await barrier(failed);
    const failedMonitor = monitors.get(missingPane)!;
    expect(failedMonitor.size).toBe(1);
    failedGate.resolve(false);
    await failed.waitFor((frame) => frame.type === "error" && frame.code === "pane_not_found");
    expect(failedMonitor.size).toBe(0);
    const afterFailure = failed.frames.length;
    watch(failed, true, missingPane);
    await failed.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", afterFailure);
    failing.stop();
    failed.ws.close();

    const stoppedGate = Promise.withResolvers<boolean>();
    const stopping = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "stopping"), sidecar: false, terminalAttach: () => stoppedGate.promise });
    bridges.push(stopping);
    const stoppedSocket = await connect(stopping);
    attach(stoppedSocket);
    watch(stoppedSocket);
    await stoppedSocket.changed(paneId);
    const stoppedMonitor = monitors.get(paneId)!;
    stopping.stop();
    expect(stoppedMonitor.size).toBe(0);
    stoppedGate.resolve(false);
    stoppedMonitor.watch(paneId);
    expect(stoppedMonitor.size).toBe(0);
  }, 45_000);

  it("continues native invalidation while another bridge holds the terminal attach slot", async () => {
    writeFileSync(path, transcript());
    await report();
    const owner = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "owner"), terminalAttach: true });
    const held = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "held"), terminalAttach: true, attachHeldRetryMs: 200 });
    bridges.push(owner, held);
    const a = await connect(owner);
    const b = await connect(held);
    attach(a);
    await a.waitFor((frame) => frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false);
    attach(b);
    watch(b);
    await b.waitFor((frame) => frame.type === "error" && frame.code === "attach_held");
    await b.changed(paneId);
    const heldMonitor = monitors.get(paneId)!;
    const after = b.frames.length;
    appendFileSync(path, `${JSON.stringify({ type: "model_change", modelId: "held-model" })}\n`);
    await b.changed(paneId, after);
    expect((await read(held)).metadata?.model).toBe("held-model");
    expect(b.frames.some((frame) => frame.type === "pty-exit")).toBe(false);
    held.stop();
    expect(heldMonitor.size).toBe(0);
    owner.stop();
    a.ws.close();
    b.ws.close();
  }, 45_000);

  it("releases native interest when the owned pane ends and refuses a stale enable", async () => {
    const socket = await connect();
    attach(socket);
    watch(socket);
    await socket.changed(paneId);
    await socket.waitFor((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId && frame.fixed === true);
    const monitor = monitors.get(paneId)!;
    await workspaceClose(workspaceId);
    workspaceId = "";
    await socket.waitFor((frame) => frame.type === "pty-exit" && frame.pane_id === paneId);
    expect(monitor.size).toBe(0);
    const after = socket.frames.length;
    watch(socket);
    await socket.waitFor((frame) => frame.type === "error" && frame.code === "not_attached", after);
    expect(monitor.size).toBe(0);
    socket.ws.close();
  }, 25_000);
});
