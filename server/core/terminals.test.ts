import { afterEach, beforeEach, expect, it, jest, mock, setSystemTime, spyOn } from "bun:test";
import { crossingMs, OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_JOIN_BYTES_PER_SECOND, OUTPUT_PAUSE_MAX_MS, OUTPUT_STALL_MS, OutputWindow, ReplayBuffer, wireBytes } from "../output-window.ts";
import { connectionData, send } from "./connections.ts";
import { createInputLane } from "./input.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import * as terminalProcess from "./terminal-process.ts";
import { ATTACH_BATCH_MAX_MS } from "./attach-batch.ts";
import * as pty from "../pty/session.ts";
import * as coreAttach from "../herdr-core/attach-session.ts";
import type { CoreAttachOptions } from "../herdr-core/attach-session.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import * as coreRuntime from "../herdr-core/runtime.ts";
import * as herdr from "../herdr/client.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { LIMITS_V1 } from "../../shared/relay-mux.ts";

let attachment: PaneAttachment;
beforeEach(() => {
  spyOn(terminalProcess, "createSpawnAttachment").mockImplementation(({ attachments }) => ({
    spawnAttachment: async (pane: string) => { attachments.set(pane, attachment); return attachment; },
  }));
});
const { createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

async function join({ readOnly = false, ready, recovering, times = 1, receiptResumeId, verifyResume, replayPrefix, retained = "retained screen" }: { readOnly?: boolean; ready: boolean; recovering?: boolean; times?: number; receiptResumeId?: string; verifyResume?: (id: string | undefined) => void; replayPrefix?: string; retained?: string }): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  };
  const replay = new ReplayBuffer(1024);
  replay.append(retained);
  attachment = {
    kind: "pty", ready, ...(recovering === undefined ? {} : { recovering }), cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay,
    process: { exited: Promise.resolve(), pause() {}, resume() {}, resize() {}, winch() {}, kill() {}, write() {}, ...(replayPrefix === undefined ? {} : { replayPrefix }) } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
  for (let attach = 0; attach < times; attach++) await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, receipt_resume_id: receiptResumeId });
  verifyResume?.(client.data.attached.get("p")?.receiptResumeId);
  registry.closeAttachment("p");
  registry.conversations.stop();
  return frames;
}

it("pauses a pane whose output waits behind a large frame queued after its attach, and starts its stall clock once that frame has crossed (#2573)", async () => {
  let buffered = 0;
  const ended: string[] = [];
  const flow: string[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => buffered, send: (text: string) => { buffered += Buffer.byteLength(text); return -1; },
    close() {},
  };
  attachment = {
    kind: "pty", ready: true, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay: new ReplayBuffer(1024),
    process: { exited: Promise.resolve(), pause() { flow.push("pause"); }, resume() { flow.push("resume"); }, resize() {}, winch() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end: (_client, reason) => { ended.push(reason); },
  });
  const start = Date.now();
  try {
    await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, flow_control: "ack" });
    expect(send(client, { type: "error", code: "x", message: "x".repeat(OUTPUT_HARD_BYTES) })).toBe(-1);
    const snapshot = buffered;
    client.data.output.get("p")!.write(OUTPUT_HIGH_BYTES, 10);
    buffered += OUTPUT_HIGH_BYTES;
    for (let at = 0; at < 5000; at += 500) { setSystemTime(start + at); registry.reconcileOutput("p"); }
    expect(flow.at(-1)).toBe("pause");
    expect(ended).toEqual([]);
    buffered -= snapshot;
    const crossed = start + 5000;
    const deadline = OUTPUT_STALL_MS + Math.ceil(10 * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
    setSystemTime(crossed); registry.reconcileOutput("p");
    setSystemTime(crossed + deadline - 1); registry.reconcileOutput("p");
    expect(ended).toEqual([]);
    setSystemTime(crossed + deadline); registry.reconcileOutput("p");
    expect(ended).toEqual(["stalled"]);
  } finally {
    setSystemTime();
    registry.closeAttachment("p");
    registry.conversations.stop();
  }
});

for (const [peers, core, name] of [
  [0, true, "keeps a slow phone that is a herdr-core pane's only viewer paused, not stopped,"],
  [1, true, "stops a slow viewer that holds a peer's herdr-core attach paused"],
  [0, false, "stops a slow only viewer of a herdr attach, whose PTY host drops an exited attach's held output at 15 s,"],
] as const) {
  it(`${name} past ${OUTPUT_PAUSE_MAX_MS} ms while it acknowledges`, async () => {
    const ended: string[] = [];
    const flow: string[] = [];
    const viewer = () => ({
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send: (text: string) => text.length, close() {},
    });
    const slow = viewer();
    attachment = {
      kind: "pty", ready: true, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay: new ReplayBuffer(1024),
      process: Object.assign(Object.create(core ? coreAttach.CoreAttachSession.prototype : Object.prototype), { exited: Promise.resolve(), pause() { flow.push("pause"); }, resume() { flow.push("resume"); }, resize() {}, winch() {}, kill() {}, write() {} }) as Extract<PaneAttachment, { kind: "pty" }>["process"],
    };
    const clients = new Set([slow, ...Array.from({ length: peers }, viewer)]);
    const registry = createTerminalRegistry({
      options: {}, clients, stopped: () => false, terminalAttach: async () => true,
      holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end: (client, reason) => { if (client === slow) ended.push(reason); },
    });
    const start = Date.now();
    try {
      for (const client of clients) await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, flow_control: "ack" });
      const window = slow.data.output.get("p")!;
      window.write(OUTPUT_HIGH_BYTES);
      let acknowledged = 0;
      for (let at = 0; at <= OUTPUT_PAUSE_MAX_MS; at += OUTPUT_STALL_MS / 2) {
        setSystemTime(start + at);
        await registry.terminalFrames["pty-ack"](slow, { type: "pty-ack", pane_id: "p", stream_id: window.id, offset: acknowledged += 1024 });
      }
      const kept = core && !peers;
      expect(ended).toEqual(kept ? [] : ["stalled"]);
      if (kept) expect(flow.at(-1)).toBe("pause");
    } finally {
      setSystemTime();
      registry.closeAttachment("p");
      registry.conversations.stop();
    }
  });
}

for (const [how, name] of [
  ["detach", "delivers the letter and wheel reports a viewer was answered for, in order, before its own detach lets the attach go, and takes nothing after it"],
  ["disconnect", "ends the attach at once, with what it had not passed on, when its last viewer's connection is taken out"],
  ["remove during drain", "kills a draining attach at once when its last viewer's connection is removed"],
  ["force close during drain", "kills a draining attach at once when its pane attachment is forced closed"],
  ["shutdown during drain", "kills a draining attach at once when the server closes all attachments"],
] as const) {
  it(`${name} (#4174)`, async () => {
    const passed: string[] = [];
    const gate = Promise.withResolvers<void>();
    const gone = Promise.withResolvers<void>();
    let taking = true;
    let running = true;
    const told: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send: (text: string) => { told.push(JSON.parse(text)); return text.length; }, close() {},
    };
    // an attach that takes bytes at once and passes them on only once the gate opens: killed, it ends with what still
    // waits; asked to leave, it takes no more and goes after all of it
    attachment = {
      kind: "pty", ready: true, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay: new ReplayBuffer(1024),
      process: {
        exited: gone.promise, pause() {}, resume() {}, resize() {}, winch() {},
        write(data: string) {
          if (!taking) return false;
          void gate.promise.then(() => { if (running) passed.push(data); });
          return true;
        },
        kill() {
          if (!running) return;
          taking = running = false; passed.push("gone"); gone.resolve();
        },
        leave() {
          taking = false;
          void gate.promise.then(() => {
            if (running) { running = false; passed.push("gone"); gone.resolve(); }
          });
        },
      } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
    };
    const clients = new Set([client]);
    const registry = createTerminalRegistry({
      options: {}, clients, stopped: () => false, terminalAttach: async () => true,
      holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
    });
    const { inputFrames } = createInputLane({
      TYPED_SETTLE_MS: 0, KEY_SETTLE_MS: 0, clients, sight: registry.sight, poke: registry.poke,
      terminalAttach: async () => true, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket() {},
    });
    try {
      await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
      const typed = ["a", ...Array.from({ length: 6 }, (_, wheel) => `\x1b[<64;10;${wheel + 1}M`)];
      typed.forEach((text, id) => inputFrames.input(client, { type: "input", pane_id: "p", text, id }));
      if (how === "disconnect") registry.detachClaimed(client);
      else registry.terminalFrames.detach(client, { type: "detach", pane_id: "p" });
      inputFrames.input(client, { type: "input", pane_id: "p", text: "b", id: typed.length });
      if (how !== "disconnect") expect(passed).toEqual([]);
      if (how === "remove during drain") {
        clients.delete(client);
        registry.detachClaimed(client);
      }
      if (how === "force close during drain") registry.closeAttachment("p");
      if (how === "shutdown during drain") registry.closeAttachments();
      if (how !== "detach") expect(passed).toEqual(["gone"]);
      gate.resolve();
      await gone.promise;
      expect(passed).toEqual(how === "detach" ? [...typed, "gone"] : ["gone"]);
      expect(told.filter((frame) => frame.type === "input-result")).toEqual([
        ...typed.map((_, id) => ({ type: "input-result" as const, id, pane_id: "p", ok: true })),
        { type: "input-result" as const, id: typed.length, pane_id: "p", ok: false, code: "input_not_ready" },
      ]);
    } finally { gate.resolve(); registry.conversations.stop(); }
  });
}

it("retains only a bounded opaque resume ID on an attach claim", async () => {
  const valid = crypto.randomUUID();
  for (const value of [valid, "", "not-a-resume-id", "x".repeat(4096), "-".repeat(36),
    "00000000-0000-0000-0000-000000000000", "12345678-1234-1234-8234-123456789abc", valid.toUpperCase()]) {
    await join({ ready: true, receiptResumeId: value, verifyResume: (id) => expect(id).toBe(value === valid ? valid : undefined) });
  }
});

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after replay for an ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames = await join({ readOnly, ready });
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready"))
      .toBeGreaterThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.some((frame) => frame.type === "output-recovering")).toBe(false);
    // a joiner that does not size the pty takes its grid before the replay drawn for it
    expect(frames.filter((frame) => frame.type === "pane-geometry")).toEqual([{ type: "pane-geometry", pane_id: "p", cols: 80, rows: 24 }]);
    expect(frames.findIndex((frame) => frame.type === "pane-geometry"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
  });
}

for (const [stream, cleared] of [
  [`${coreAttach.CLEAR_HISTORY}whole stream`, "none"],
  [`${coreAttach.CLEAR_HISTORY}${"h".repeat(2048)}main tail`, "ahead"],
  [`\x1b[?1049h${"a".repeat(2048)}alternate tail`, "none"],
  [`\x1b[?1049h${"a".repeat(2048)}\x1b[?1049lshell after`, "where it leaves"],
] as const) {
  it(`clears a herdr-core joiner's kept history once in its cut tail (${cleared}): ${stream.slice(-14)}`, async () => {
    const frames = await join({ ready: true, replayPrefix: coreAttach.CLEAR_JOINER_HISTORY, retained: stream });
    const tail = new ReplayBuffer(1024);
    tail.append(stream);
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      { type: "pty-data", pane_id: "p", data: cleared === "ahead" ? coreAttach.CLEAR_JOINER_HISTORY + tail.text()
        : cleared === "where it leaves" ? tail.text().replace("\x1b[?1049l", coreAttach.CLEAR_JOINER_HISTORY) : tail.text(), replay: true },
    ]);
    expect(coreAttach.CLEAR_JOINER_HISTORY).not.toMatch(/\x1b\[[02]?J|\x1b\[H/);
  });
}

for (const readOnly of [false, true]) {
  it(`tells an ${readOnly ? "observer" : "owner"} joining a recovering attach that its replay is the screen from before, once`, async () => {
    const frames = await join({ readOnly, ready: false, recovering: true, times: 2 });
    expect(frames.filter((frame) => frame.type === "output-recovering")).toEqual([{ type: "output-recovering", pane_id: "p" }]);
    expect(frames.findIndex((frame) => frame.type === "output-recovering"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual([]);
  });
}

const REFUSAL = "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n";
for (const [name, reads, screen] of [
  ["an OSC cut across reads before the refusal", ["\x1b[?1049h", "\x1b]", `0;title\x07${REFUSAL}`], ""],
  ["a non-CSI escape before the refusal", ["\x1b[?1049h\x1b7", `\x1b8${REFUSAL}`], ""],
  ["a refusal after the screen it released", ["\x1b[?1049h\x1b[2J\x1b[1;1Hpane text", `\r\n${REFUSAL}`], "pane text"],
] as const) {
  it(`never paints herdr's refusal: ${name}`, async () => {
    mock.restore();
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({
      panes: [{ pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
      layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
    } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>);
    spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
    const attempts: pty.PtySessionOptions[] = [];
    const RealPtySession = pty.PtySession;
    mock.module("../pty/session.ts", () => ({
      PtySession: class {
        readonly exited = Promise.withResolvers<void>().promise;
        constructor(options: pty.PtySessionOptions) { attempts.push(options); }
        kill() {}
        pause() {}
        resume() {}
        resize() {}
        winch() {}
        write() { return true; }
      },
    }));
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    };
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false,
      terminalAttach: async () => true, holdFor: 60_000, heldRetry: 60_000, retryFor: 0, relookupFor: 5_000,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
    });
    try {
      await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
      const attach = attempts[0];
      if (!attach) throw new Error("no attach was started");
      for (const read of reads) attach.onData(read);
      const painted = (): string => frames.flatMap((frame) => frame.type === "pty-data" ? [frame.data] : []).join("");
      expect(painted().includes(screen)).toBe(true);
      expect(frames.some((frame) => frame.type === "input-ready" && frame.ready !== false)).toBe(screen !== "");
      attach.onExit(1);
      expect(painted()).not.toContain("terminal attach failed");
      expect(painted()).not.toContain("title");
      expect(frames.filter((frame) => frame.type === "error").map((frame) => frame.type === "error" && frame.code)).toEqual(["attach_held"]);
    } finally {
      registry.closeAttachment("p");
      registry.conversations.stop();
      mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
    }
  });
}

for (const resized of [false, true]) {
  it(`${resized ? "keeps the hold for an attach resized before its screen" : "settles an attach on its first screen"}`, async () => {
    mock.restore();
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({
      panes: [{ pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
      layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
    } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>);
    spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
    const attempts: pty.PtySessionOptions[] = [];
    const RealPtySession = pty.PtySession;
    mock.module("../pty/session.ts", () => ({
      PtySession: class {
        readonly exited = Promise.withResolvers<void>().promise;
        constructor(options: pty.PtySessionOptions) { attempts.push(options); }
        kill() {}
        pause() {}
        resume() {}
        resize() {}
        winch() {}
        write() { return true; }
      },
    }));
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    };
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false,
      terminalAttach: async () => true, holdFor: 60_000, heldRetry: 60_000, retryFor: 0, relookupFor: 5_000,
      holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
    });
    try {
      await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24 });
      const attach = attempts[0];
      if (!attach) throw new Error("no attach was started");
      if (resized) await registry.terminalFrames.resize(client, { type: "resize", pane_id: "p", cols: 91, rows: 27 });
      attach.onData("\x1b[?1049h\x1b[2J\x1b[1;1Hpane text");
      expect(frames.some((frame) => frame.type === "input-ready" && frame.ready !== false)).toBe(!resized);
    } finally {
      registry.closeAttachment("p");
      registry.conversations.stop();
      mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
    }
  });
}

/** herdr 0.9.5's whole screen, shaped as captured through the PTY host: one synchronized update that starts every row and fills it to the width */
function herdrScreen(cols: number, rows: number, text: string, first = false): string {
  let rest = "";
  for (let row = 2; row <= rows; row++) rest += `\x1b[${row};1H${" ".repeat(cols)}`;
  return `\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\${first ? "\x1b[2J" : ""}\x1b[1;1H\x1b[0;39;49m${text.padEnd(cols)}${rest}\x1b[0m\x1b[1;${text.length + 1}H\x1b[?25h\x1b[?2026l\x1b[1;${text.length + 1}H\x1b[?25h`;
}

async function resizableAttach() {
  mock.restore();
  spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [{ pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
    layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>);
  spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
  const attempts: pty.PtySessionOptions[] = [];
  const RealPtySession = pty.PtySession;
  const writes: string[] = [];
  const coreAttaches: CoreAttachOptions[] = [];
  const RealCoreAttachSession = coreAttach.CoreAttachSession;
  mock.module("../herdr-core/attach-session.ts", () => ({
    CoreAttachSession: class {
      readonly exited = Promise.withResolvers<void>().promise;
      constructor(options: CoreAttachOptions) { coreAttaches.push(options); }
      kill() {}
      pause() {}
      resume() {}
      resize() {}
      winch() {}
      write(data: string) { writes.push(data); return true; }
    },
  }));
  mock.module("../pty/session.ts", () => ({
    PtySession: class {
      readonly exited = Promise.withResolvers<void>().promise;
      constructor(options: pty.PtySessionOptions) { attempts.push(options); }
      kill() {}
      pause() {}
      resume() {}
      resize() {}
      winch() {}
      write(data: string) { writes.push(data); return true; }
    },
  }));
  const frames: ServerMessage[] = [];
  const ended: string[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0,
    send(raw: string) {
      const frame = JSON.parse(raw) as ServerMessage;
      frames.push(frame);
      if (frame.type === "pty-data" && frame.flow) registry.terminalFrames["pty-ack"](client, { type: "pty-ack", pane_id: "p", stream_id: frame.flow.stream_id, offset: frame.flow.offset });
      return raw.length;
    },
    close() {},
  };
  jest.useFakeTimers();
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false,
    terminalAttach: async () => true, holdFor: terminalProcess.ATTACH_HOLD_MS, heldRetry: 60_000, retryFor: 0, relookupFor: 5_000,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end(_client, reason) { ended.push(reason); },
  });
  await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, flow_control: "ack" });
  const attach = attempts[0] ?? coreAttaches[0];
  if (!attach) throw new Error("no attach was started");
  return {
    attach, pty: attempts[0], core: coreAttaches[0], ended, writes,
    ready: (): boolean => frames.some((frame) => frame.type === "input-ready" && frame.ready !== false),
    painted: (): string => frames.flatMap((frame) => frame.type === "pty-data" ? [frame.data] : []).join(""),
    sent: (): string[] => frames.flatMap((frame) => frame.type === "pty-data" ? [frame.data] : []),
    resize: (cols: number, rows: number) => registry.terminalFrames.resize(client, { type: "resize", pane_id: "p", cols, rows }),
    [Symbol.dispose]() {
      jest.useRealTimers();
      registry.closeAttachment("p");
      registry.conversations.stop();
      mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
      mock.module("../herdr-core/attach-session.ts", () => ({ CoreAttachSession: RealCoreAttachSession }));
    },
  };
}

const TAKEOVER = "\x1b[?1049l\x1b[?25h\x1b[0 qherdr: server shut down: terminal attach taken over\r\n";

it("never paints herdr's takeover diagnostic when the displaced attach exits after the hold", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  expect(pane.ready()).toBe(true);
  pane.attach.onData(TAKEOVER);
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 10);
  pane.attach.onExit(1);
  expect(pane.painted()).not.toContain("terminal attach taken over");
  expect(pane.painted().endsWith("\x1b[?1049l\x1b[?25h\x1b[0 q")).toBe(true);
});

it("passes on the start of a takeover diagnostic that never completes once the exit wait runs out", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  const partial = TAKEOVER.slice(0, TAKEOVER.indexOf("taken"));
  pane.attach.onData(partial);
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS + terminalProcess.ATTACH_TAKEOVER_EXIT_MS - 1);
  expect(pane.painted()).not.toContain("herdr: server shut down");
  jest.advanceTimersByTime(1);
  expect(pane.painted().endsWith(partial)).toBe(true);
});

for (const cut of [TAKEOVER.indexOf("herdr"), TAKEOVER.indexOf(" down"), 3]) {
  it(`never paints herdr's takeover diagnostic split ${cut} bytes in, its reads far apart`, async () => {
    using pane = await resizableAttach();
    pane.attach.onData(herdrScreen(80, 24, "pane text", true));
    jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 10);
    pane.attach.onData(TAKEOVER.slice(0, cut));
    jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 5);
    pane.attach.onData(TAKEOVER.slice(cut));
    jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 5);
    pane.attach.onExit(1);
    expect(pane.painted()).not.toContain("herdr");
    expect(pane.painted().endsWith("\x1b[?1049l\x1b[?25h\x1b[0 q")).toBe(true);
  });
}

it("waits one bounded time from the diagnostic's first byte, however many line ends follow it", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 10);
  pane.attach.onData(TAKEOVER);
  jest.advanceTimersByTime(terminalProcess.ATTACH_TAKEOVER_EXIT_MS - 500);
  pane.attach.onData("\r\n");
  jest.advanceTimersByTime(499);
  expect(pane.painted()).not.toContain("terminal attach taken over");
  jest.advanceTimersByTime(1);
  expect(pane.painted().endsWith(TAKEOVER + "\r\n")).toBe(true);
});

it("passes on a pane's own takeover words when no exit follows them", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  pane.attach.onData(TAKEOVER);
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS + terminalProcess.ATTACH_TAKEOVER_EXIT_MS - 1);
  expect(pane.painted()).not.toContain("terminal attach taken over");
  jest.advanceTimersByTime(1);
  expect(pane.painted().endsWith(TAKEOVER)).toBe(true);
});

for (const onCore of [true, false]) {
  it(`isolates ${onCore ? "a core stream from herdr probes, with no PTY" : "herdr attach startup probes and socket env"}`, async () => {
    const previousSocketPath = process.env["HERDR_SOCKET_PATH"];
    serveRuntime(onCore ? HERDR_CORE : null);
    process.env["HERDR_SOCKET_PATH"] = "/fixture/inherited-herdr.sock";
    try {
      using pane = await resizableAttach();
      const query = "\x1b[c";
      const setup = "\x1b[?1049h";
      pane.attach.onData(query + setup);
      if (onCore) {
        jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);
        expect(pane.painted()).toBe(query + setup);
        expect(pane.ready()).toBe(true);
        expect(pane.writes).toEqual([]);
        expect(pane.pty).toBeUndefined();
        expect(pane.core).toMatchObject({ terminal: "term_0", cols: 80, rows: 24 });
      } else {
        expect(pane.painted()).toBe("");
        expect(pane.ready()).toBe(false);
        expect(pane.writes).toEqual(["\x1b[?1;2c"]);
        expect(pane.pty?.env).toEqual({ HERDR_SOCKET_PATH: herdr.herdrSocketPath() });
        expect(pane.pty?.args).toEqual(["terminal", "attach", "term_0"]);
        expect(pane.pty?.leaveAt).toBe(process.platform === "win32" ? undefined : terminalProcess.ATTACH_LEAVE);
        pane.attach.onData("screen");
        expect(pane.painted()).toBe(setup + "screen");
      }
    } finally {
      serveRuntime(null);
      if (previousSocketPath === undefined) delete process.env["HERDR_SOCKET_PATH"];
      else process.env["HERDR_SOCKET_PATH"] = previousSocketPath;
    }
  });
}

it("sends a herdr-core attach's history replay as one frame once hc's paint ends, so a viewer opens it at its newest rows, then output as it comes", async () => {
  serveRuntime(HERDR_CORE);
  try {
    using pane = await resizableAttach();
    for (const chunk of ["\x1b[3Jhistory 1\r\n", "history 2\r\n", "screen"]) {
      pane.attach.onData(chunk);
      jest.advanceTimersByTime(20);
    }
    expect(pane.ready()).toBe(true);
    expect(pane.sent()).toEqual([]);
    pane.core!.onPaintEnd();
    expect(pane.sent()).toEqual(["\x1b[3Jhistory 1\r\nhistory 2\r\nscreen"]);
    pane.attach.onData("live");
    expect(pane.sent().at(-1)).toBe("live");
  } finally {
    serveRuntime(null);
  }
});

function corePane() {
  mock.restore();
  serveRuntime(HERDR_CORE);
  jest.useFakeTimers();
  const pane = { pane_id: "p", terminal_id: "term_0", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const };
  const snapshot = { panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture" };
  const lookup = spyOn(herdr, "sessionSnapshot").mockResolvedValue(snapshot);
  spyOn(Bun, "which").mockReturnValue("/fixture/hc");
  const hc = new HcConnection(() => { throw new Error("fixture must not open a real transport"); });
  const closed = Promise.withResolvers<void>();
  const close = mock(() => closed.promise);
  const open = spyOn(hc, "open").mockResolvedValue({
    result: { channel: 1, automatic_input: false, resize_notifications: false, terminal: {
      address: "term_0", argv: [], cols: 80, created_ms: 0, cwd: pane.cwd, labels: {}, rows: 24, screen: "", state: "running",
    } },
    channel: { id: 1, automaticInput: false, close, credit() {}, resize() {}, write() {}, writeAutomatic() {}, focus() {}, facts() {} },
  });
  let opening = Promise.withResolvers<void>();
  spyOn(coreRuntime, "coreConnection").mockImplementation(() => {
    opening.resolve();
    opening = Promise.withResolvers<void>();
    return hc;
  });
  const channel = () => {
    const handlers = open.mock.calls.at(-1)?.[2];
    if (!handlers) throw new Error("no core stream was opened");
    return handlers;
  };
  const viewer = () => {
    const frames: ServerMessage[] = [];
    const exited = Promise.withResolvers<void>();
    return {
      frames, exited: exited.promise,
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, close() {},
      send(raw: string) {
        const frame = JSON.parse(raw) as ServerMessage;
        frames.push(frame);
        if (frame.type === "pty-exit") exited.resolve();
        return Buffer.byteLength(raw);
      },
    };
  };
  const client = viewer();
  const clients = new Set([client]);
  const registry = createTerminalRegistry({
    options: {}, clients, stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 5_000,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
  const join = (member = client) => {
    clients.add(member);
    return registry.terminalFrames.attach(member, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, flow_control: "ack" });
  };
  return {
    client, registry, viewer, join, close,
    data: (text: string | Uint8Array) => channel().onData(typeof text === "string" ? Buffer.from(text) : text),
    async replace() {
      const opened = opening.promise;
      channel().onClose?.({ exit_code: 0 });
      await opened;
    },
    removePane() {
      lookup.mockResolvedValue({ ...snapshot, panes: [] });
      channel().onClose?.({ exit_code: 0 });
    },
    [Symbol.dispose]() {
      registry.closeAttachments();
      registry.conversations.stop();
      closed.resolve();
      jest.useRealTimers();
      serveRuntime(null);
    },
  };
}

const coreOutput = (frames: readonly ServerMessage[]) => frames.filter((frame) => frame.type === "pty-data");

it("replays pre-join core bytes only to the joining viewer and delivers post-join bytes live", async () => {
  using pane = corePane();
  await pane.join();
  pane.client.frames.length = 0;
  pane.data("before join");
  const peer = pane.viewer();
  await pane.join(peer);
  pane.data("after join");
  jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);

  const [before, after, ...rest] = coreOutput(peer.frames);
  expect(before).toMatchObject({ replay: true });
  expect(before?.data).toEndWith("before join");
  expect(after?.data).toBe("after join");
  expect(after?.replay).toBeUndefined();
  expect(rest).toEqual([]);
  expect(coreOutput(pane.client.frames).map(({ replay }) => replay)).toEqual([undefined, undefined]);
});

it("delivers held core output before changing the viewer's grid", async () => {
  using pane = corePane();
  await pane.join();
  const peer = pane.viewer();
  await pane.join(peer);
  peer.frames.length = 0;
  pane.data("old grid");
  await pane.registry.terminalFrames.resize(pane.client, { type: "resize", pane_id: "p", cols: 40, rows: 24 });
  jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);

  expect(peer.frames.map((frame) => frame.type)).toEqual(["pty-data", "pane-geometry"]);
  expect(coreOutput(peer.frames)[0]?.data).toEndWith("old grid");
});

it("publishes replacement core output before input-ready and includes it in a joiner's replay", async () => {
  using pane = corePane();
  await pane.join();
  pane.data("old screen");
  jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);
  await pane.replace();
  pane.client.frames.length = 0;
  pane.data("replacement screen");
  const peer = pane.viewer();
  await pane.join(peer);

  expect(pane.client.frames.map((frame) => frame.type)).toEqual(["pty-data", "input-ready"]);
  expect(coreOutput(peer.frames)[0]).toMatchObject({ replay: true });
  expect(coreOutput(peer.frames)[0]?.data).toEndWith("replacement screen");
});

it("holds hc's first paint through pauses until its 9001 mark, though a frame splits the mark, then passes output on as it comes", async () => {
  using pane = corePane();
  await pane.join();
  jest.advanceTimersByTime(20);
  pane.data("\x18history one\r\n");
  jest.advanceTimersByTime(20);
  pane.data("history two\r\nscreen\x1b[0m\x1b[?90");
  jest.advanceTimersByTime(20);
  const historyFrames = () => coreOutput(pane.client.frames).filter(({ data }) => data.includes("history") || data.includes("screen"));
  expect(historyFrames()).toEqual([]);
  pane.data("01lprompt");
  expect(historyFrames().map(({ data }) => data.slice(data.indexOf("\x18")))).toEqual(["\x18history one\r\nhistory two\r\nscreen\x1b[0m\x1b[?9001lprompt"]);
  pane.data("live");
  expect(coreOutput(pane.client.frames).at(-1)?.data).toBe("live");
});

it("splits control-heavy core batches below the legacy relay limit without losing a UTF-8 character", async () => {
  using pane = corePane();
  await pane.join();
  // Leave one byte after hc's clear so the next character straddles the 40 KiB split.
  const beforeEmoji = 40 * 1024 - Buffer.byteLength(coreAttach.CLEAR_HISTORY) - 1;
  const history = Buffer.from("\x1b".repeat(beforeEmoji) + "🍏" + "\0".repeat(OUTPUT_HIGH_BYTES));
  for (let at = 0; at < history.length; at += 16 * 1024) pane.data(history.subarray(at, at + 16 * 1024));
  jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);
  const frames = coreOutput(pane.client.frames);

  expect(Math.max(...frames.map((frame) => Buffer.byteLength(JSON.stringify(frame))))).toBeLessThan(LIMITS_V1.max_ws_message_bytes);
  expect(Math.max(...frames.map(({ data }) => Buffer.byteLength(data)))).toBeLessThanOrEqual(40 * 1024);
  expect(frames.map(({ data }) => data).join("")).toEndWith(history.toString());
});

it("lets a healthy shared viewer drain an ANSI-heavy core batch before the pause limit", async () => {
  using pane = corePane();
  await pane.join();
  const line = "\x1b[31m" + "text".repeat(2) + "\r\n";
  const history = Buffer.from(line.repeat(Math.ceil(OUTPUT_HIGH_BYTES / line.length)).slice(0, OUTPUT_HIGH_BYTES));
  for (let at = 0; at < history.length; at += 16 * 1024) pane.data(history.subarray(at, at + 16 * 1024));
  jest.advanceTimersByTime(ATTACH_BATCH_MAX_MS);
  const window = new OutputWindow();
  const acks = coreOutput(pane.client.frames).map(({ data }) => ({
    offset: window.write(Buffer.byteLength(data), wireBytes(data)), wire: wireBytes(data),
  }));
  expect(window.check(0)).toBe("pause");
  let crossed = 0;
  let elapsed = 0;
  for (const { offset, wire } of acks) {
    crossed += wire;
    const next = crossingMs(crossed);
    if (next >= OUTPUT_PAUSE_MAX_MS) break;
    jest.advanceTimersByTime(next - elapsed);
    elapsed = next;
    window.acknowledge(window.id, offset);
  }
  jest.advanceTimersByTime(OUTPUT_PAUSE_MAX_MS - elapsed);
  expect(window.check(0)).toBe("flow");
});

for (const action of ["detach", "disconnect"] as const) {
  it(`cancels held core output timers on last-viewer ${action} without waiting for hc`, async () => {
    using pane = corePane();
    await pane.join();
    pane.data("held");
    expect(jest.getTimerCount()).toBe(1);

    if (action === "detach") pane.registry.terminalFrames.detach(pane.client, { type: "detach", pane_id: "p" });
    else pane.registry.detachClaimed(pane.client);
    expect(pane.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
}

it("passes on a herdr-core attach's first output at its deadline when hc never marks the paint's end", async () => {
  using pane = corePane();
  await pane.join();
  pane.client.frames.length = 0;
  const interval = 10;
  for (let at = 0; at < ATTACH_BATCH_MAX_MS; at += interval) {
    pane.data("line\r\n");
    jest.advanceTimersByTime(Math.min(interval, ATTACH_BATCH_MAX_MS - 1 - at));
  }
  expect(coreOutput(pane.client.frames)).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(coreOutput(pane.client.frames).map(({ data }) => data.slice(data.indexOf("line"))))
    .toEqual(["line\r\n".repeat(Math.ceil(ATTACH_BATCH_MAX_MS / interval))]);
  pane.data("next");
  expect(coreOutput(pane.client.frames).at(-1)?.data).toBe("next");
});

it("passes on a herdr-core attach's held output before pty-exit when the pane is gone", async () => {
  using pane = corePane();
  await pane.join();
  pane.client.frames.length = 0;
  pane.data("last words");
  pane.removePane();
  await pane.client.exited;
  expect(coreOutput(pane.client.frames).map(({ data }) => data.endsWith("last words"))).toEqual([true]);
  expect(pane.client.frames.filter((frame) => frame.type === "pty-data" || frame.type === "pty-exit").map(({ type }) => type))
    .toEqual(["pty-data", "pty-exit"]);
});

it("attaches with herdr's own command where OVIS_RUNTIME names herdr-core but no runtime was started", async () => {
  const previous = process.env["OVIS_RUNTIME"];
  process.env["OVIS_RUNTIME"] = "herdr-core";
  try {
    using pane = await resizableAttach();
    expect(pane.core).toBeUndefined();
    expect(pane.pty?.args).toEqual(["terminal", "attach", "term_0"]);
  } finally {
    if (previous === undefined) delete process.env["OVIS_RUNTIME"];
    else process.env["OVIS_RUNTIME"] = previous;
  }
});

for (const ordering of ["a resize back to the start size", "a redraw later than the hold", "a screen queued from before a round trip"] as const) {
  it(`keeps a resized attach held until herdr draws the current grid: ${ordering}`, async () => {
    using pane = await resizableAttach();
    const { attach, ready, painted, resize } = pane;
    await resize(91, 27);
    let current = herdrScreen(91, 27, "current");
    if (ordering === "a screen queued from before a round trip") {
      await resize(80, 24);
      attach.onData(herdrScreen(80, 24, "old", true) + herdrScreen(91, 27, "between").replaceAll("\x1b[1;8H", "\x1b[2;1H"));
      expect(ready()).toBe(false);
      current = herdrScreen(80, 24, "current");
    } else {
      attach.onData(herdrScreen(80, 24, "old", true));
      expect(ready()).toBe(false);
      if (ordering === "a resize back to the start size") {
        await resize(80, 24);
        attach.onData(herdrScreen(91, 27, "between"));
        expect(ready()).toBe(false);
        current = herdrScreen(80, 24, "current");
      } else {
        jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS);
        expect(ready()).toBe(false);
        expect(painted()).toBe("");
      }
    }
    const end = current.indexOf("\x1b[?2026l") + "\x1b[?2026l".length;
    for (let at = 0; at < current.length; at += 5) {
      expect([at, ready()]).toEqual([at, false]);
      attach.onData(current.slice(at, at + 5));
      if (at + 5 >= end) break;
    }
    expect(ready()).toBe(true);
    attach.onData(current.slice(Math.ceil(end / 5) * 5));
    jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS);
    expect(painted().endsWith(current)).toBe(true);
  });
}

it("lets a resized attach go when herdr never draws its current grid", async () => {
  using pane = await resizableAttach();
  await pane.resize(91, 27);
  pane.attach.onData(herdrScreen(80, 24, "old", true));
  jest.advanceTimersByTime(terminalProcess.ATTACH_RESIZE_REDRAW_MS - 1);
  expect(pane.ready()).toBe(false);
  jest.advanceTimersByTime(1);
  expect(pane.ready()).toBe(true);
});

for (const late of [false, true]) {
  it(`lets a resized attach go before a busy pane's held output is too much for one frame, ${late ? "after" : "in"} the hold (#2289 review)`, async () => {
    using pane = await resizableAttach();
    await pane.resize(91, 27);
    pane.attach.onData(herdrScreen(80, 24, "old", true));
    if (late) jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS);
    const stale = herdrScreen(80, 24, "busy");
    for (let read = 0; read < 600 && !pane.ready(); read++) pane.attach.onData(stale);
    expect(pane.ready()).toBe(true);
    pane.attach.onData(herdrScreen(91, 27, "current"));
    expect(pane.ended).toEqual([]);
    expect(pane.painted()).toContain("current");
  });
}

it("settles on the redraw when a diff of the top row follows it in the same read (#2289 review)", async () => {
  using pane = await resizableAttach();
  await pane.resize(91, 27);
  pane.attach.onData(herdrScreen(80, 24, "old", true));
  pane.attach.onData(`${herdrScreen(91, 27, "current")}\x1b[?2026h\x1b[1;1H${"x".repeat(91)}\x1b[?2026l`);
  expect(pane.ready()).toBe(true);
});

it("marks a newcomer recovering after a ready stream ends and clears it when the next attach takes", async () => {
  mock.restore();
  const snapshot = (terminalId: string) => ({
    panes: [{ pane_id: "p", terminal_id: terminalId, workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent_status: "idle" as const }],
    layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const lookup = Promise.withResolvers<ReturnType<typeof snapshot>>();
  spyOn(herdr, "sessionSnapshot").mockResolvedValueOnce(snapshot("old")).mockImplementation(() => lookup.promise);
  spyOn(Bun, "which").mockReturnValue("/fixture/herdr");
  const attempts: pty.PtySessionOptions[] = [];
  const restarted = Promise.withResolvers<pty.PtySessionOptions>();
  const RealPtySession = pty.PtySession;
  mock.module("../pty/session.ts", () => ({
    PtySession: class {
      private readonly exit = Promise.withResolvers<void>();
      readonly exited = this.exit.promise;
      constructor(options: pty.PtySessionOptions) {
        attempts.push(options);
        if (attempts.length === 2) restarted.resolve(options);
      }
      kill() { this.exit.resolve(); }
      pause() {}
      resume() {}
      resize() {}
      winch() {}
      write() { return true; }
    },
  }));
  const record = () => {
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send(raw: string) { frames.push(JSON.parse(raw)); return raw.length; }, close() {},
    };
    return { client, frames };
  };
  const owner = record(), recovering = record(), recovered = record();
  let ready = Promise.withResolvers<void>();
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([owner.client, recovering.client, recovered.client]), stopped: () => false,
    terminalAttach: async () => true, holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 5_000,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() { ready.resolve(); }, end() {},
  });
  const attach = { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true } as const;
  try {
    await registry.terminalFrames.attach(owner.client, attach);
    const first = attempts[0];
    if (!first) throw new Error("initial PTY was not started");
    first.onData("retained screen");
    await ready.promise;

    first.onExit(0);
    await registry.terminalFrames.attach(recovering.client, attach);
    expect(recovering.frames.filter((frame) => ["output-recovering", "pty-data", "input-ready"].includes(frame.type))).toEqual([
      { type: "output-recovering", pane_id: "p" },
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);

    ready = Promise.withResolvers<void>();
    lookup.resolve(snapshot("new"));
    const next = await restarted.promise;
    expect(next.args).toEqual(["terminal", "attach", "new"]);
    next.onData("current screen");
    await ready.promise;
    await registry.terminalFrames.attach(recovered.client, attach);
    expect(recovered.frames.filter((frame) => ["output-recovering", "pty-data", "input-ready"].includes(frame.type))).toEqual([
      { type: "pty-data", pane_id: "p", data: "retained screencurrent screen", replay: true },
      { type: "input-ready", pane_id: "p" },
    ]);
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
    mock.module("../pty/session.ts", () => ({ PtySession: RealPtySession }));
  }
});

it("makes the new ID's first attach wait for the old ID's process, also while it is created and across a second move (#1503)", async () => {
  let retiring: Map<string, Promise<void>> | undefined;
  const created = Promise.withResolvers<PaneAttachment>();
  const exited = Promise.withResolvers<void>();
  const killed: string[] = [];
  mock.restore();
  spyOn(terminalProcess, "createSpawnAttachment").mockImplementation(({ attachments, retiringAttachments }) => {
    retiring = retiringAttachments;
    return { spawnAttachment: async (pane: string) => { const made = await created.promise; attachments.set(pane, made); return made; } };
  });
  const frames: ServerMessage[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
    close() {},
  };
  const registry = createTerminalRegistry({
    options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
  try {
    const attaching = registry.terminalFrames.attach(client, { type: "attach", pane_id: "A", cols: 80, rows: 24 });
    registry.paneMoved("A", "B");
    const waitB = retiring?.get("B");
    expect(waitB).toBeDefined();
    created.resolve({
      kind: "pty", ready: true, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay: new ReplayBuffer(1024),
      process: { exited: exited.promise, pause() {}, resume() {}, resize() {}, winch() {}, kill() { killed.push("A"); }, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
    });
    await attaching;
    await Promise.resolve();
    registry.paneMoved("B", "C");
    const waitC = retiring?.get("C");
    expect(waitC).toBeDefined();
    let settled = false;
    void Promise.all([waitB, waitC]).then(() => { settled = true; });
    await created.promise.then(() => undefined);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(killed).toEqual(["A"]);
    expect(frames).toContainEqual({ type: "pty-exit", pane_id: "A", code: null });
    expect(client.data.attached.has("A")).toBe(false);
    expect(settled).toBe(false);
    exited.resolve();
    await Promise.all([waitB, waitC]);
    expect(retiring?.has("B")).toBe(false);
    expect(retiring?.has("C")).toBe(false);
  } finally { registry.conversations.stop(); }
});
