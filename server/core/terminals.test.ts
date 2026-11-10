import { afterEach, beforeEach, expect, it, jest, mock, setSystemTime, spyOn } from "bun:test";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_JOIN_BYTES_PER_SECOND, OUTPUT_STALL_MS, ReplayBuffer } from "../output-window.ts";
import { connectionData, send } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import * as terminalProcess from "./terminal-process.ts";
import * as pty from "../pty/session.ts";
import * as coreAttach from "../herdr-core/attach-session.ts";
import type { CoreAttachOptions } from "../herdr-core/attach-session.ts";
import * as herdr from "../herdr/client.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

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
  // a pane that has written nothing yet: no replay
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
    // a reconnect: the browser attaches on open, and the session's snapshot, past the transport budget, queues after that
    await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, flow_control: "ack" });
    expect(send(client, { type: "error", code: "x", message: "x".repeat(OUTPUT_HARD_BYTES) })).toBe(-1);
    const snapshot = buffered;
    // the pane's output queues behind it in small frames, up to the high-water mark
    client.data.output.get("p")!.write(OUTPUT_HIGH_BYTES, 10);
    buffered += OUTPUT_HIGH_BYTES;
    for (let at = 0; at < 5000; at += 500) { setSystemTime(start + at); registry.reconcileOutput("p"); }
    // still paused, so the backlog behind the snapshot grows no further, and not closed
    expect(flow.at(-1)).toBe("pause");
    expect(ended).toEqual([]);
    // the snapshot crossed: the output behind it gets the usual deadline from now
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

it("retains only a bounded opaque resume ID on an attach claim", async () => {
  const valid = crypto.randomUUID();
  // only the UUIDv4 the browser generates: not 36 dashes, another UUID version or upper case
  for (const value of [valid, "", "not-a-resume-id", "x".repeat(4096), "-".repeat(36),
    "00000000-0000-0000-0000-000000000000", "12345678-1234-1234-8234-123456789abc", valid.toUpperCase()]) {
    await join({ ready: true, receiptResumeId: value, verifyResume: (id) => expect(id).toBe(value === valid ? valid : undefined) });
  }
});

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after replay for an ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames = await join({ readOnly, ready });
    expect(frames.filter((frame) => frame.type === "pty-data")).toEqual([
      // the joiner's replay, marked as the screen from before, byte for byte
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);
    // An input-ready receipt is the existing attach-complete barrier for queued input,
    // not an output-presentation notification. No early negative receipt may satisfy it.
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready"))
      .toBeGreaterThan(frames.findIndex((frame) => frame.type === "pty-data"));
    expect(frames.some((frame) => frame.type === "output-recovering")).toBe(false);
  });
}

// #2664 review: a herdr-core joiner's bounded tail may have lost the attach's clear, and the history it kept doubled;
// a tail on the alternate screen keeps no history, and leaving that screen blanked what the tail restores;
// one that leaves it again reprinted the shell's lines after it into the history the joiner kept
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
    // #2664 review: rows a cut tail of in-place updates never draws again stay on the joiner's screen
    expect(coreAttach.CLEAR_JOINER_HISTORY).not.toMatch(/\x1b\[[02]?J|\x1b\[H/);
  });
}

for (const readOnly of [false, true]) {
  it(`tells an ${readOnly ? "observer" : "owner"} joining a recovering attach that its replay is the screen from before, once`, async () => {
    const frames = await join({ readOnly, ready: false, recovering: true, times: 2 });
    expect(frames.filter((frame) => frame.type === "output-recovering")).toEqual([{ type: "output-recovering", pane_id: "p" }]);
    expect(frames.findIndex((frame) => frame.type === "output-recovering"))
      .toBeLessThan(frames.findIndex((frame) => frame.type === "pty-data"));
    // presentation only: the queued-input barrier still waits for the attach to take
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual([]);
  });
}

const REFUSAL = "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n";
for (const [name, reads, screen] of [
  // #2255 review: an OSC's opening read released the hold, and the refusal after it was painted
  ["an OSC cut across reads before the refusal", ["\x1b[?1049h", "\x1b]", `0;title\x07${REFUSAL}`], ""],
  ["a non-CSI escape before the refusal", ["\x1b[?1049h\x1b7", `\x1b8${REFUSAL}`], ""],
  // printable screen text releases the hold at once, but a refusal after it is still never painted
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
    // a hold and a retry that never run out here: only what the reads say decides
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
      // a screen is passed on before the exit, without waiting out the hold
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
      // #2255 CI: the screen herdr drew before it applied this size is not yet the pane at that size,
      // so input waits out the hold as it did before the early settle
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

/** an attach at 80x24 through the real attach lifecycle, its PTY mocked, on fake timers and a client that acknowledges its output */
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

// take-over-regression CI: a displaced attach whose exit came after the hold had its diagnostic painted
it("never paints herdr's takeover diagnostic when the displaced attach exits after the hold", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  expect(pane.ready()).toBe(true);
  pane.attach.onData(TAKEOVER);
  // a busy host: the exit comes well after the hold ran out
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS * 10);
  pane.attach.onExit(1);
  expect(pane.painted()).not.toContain("terminal attach taken over");
  // herdr's teardown of the alternate screen still reaches the terminal
  expect(pane.painted().endsWith("\x1b[?1049l\x1b[?25h\x1b[0 q")).toBe(true);
});

it("passes on the start of a takeover diagnostic that never completes once the exit wait runs out", async () => {
  using pane = await resizableAttach();
  pane.attach.onData(herdrScreen(80, 24, "pane text", true));
  const partial = TAKEOVER.slice(0, TAKEOVER.indexOf("taken"));
  pane.attach.onData(partial);
  // right after the screen, the refusal guard holds the line for one hold, then the tail waits for the rest or the exit
  jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS + terminalProcess.ATTACH_TAKEOVER_EXIT_MS - 1);
  expect(pane.painted()).not.toContain("herdr: server shut down");
  jest.advanceTimersByTime(1);
  expect(pane.painted().endsWith(partial)).toBe(true);
});

// #2630 review: reads more than a hold apart split the diagnostic, and its words were painted without their teardown
for (const cut of [TAKEOVER.indexOf("herdr"), TAKEOVER.indexOf(" down"), 3]) {
  it(`never paints herdr's takeover diagnostic split ${cut} bytes in, its reads far apart`, async () => {
    using pane = await resizableAttach();
    pane.attach.onData(herdrScreen(80, 24, "pane text", true));
    // past the refusal guard's window: only the tail stands between these reads and the tab
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

// #2630 review: each later read restarted the wait, and text shaped like the diagnostic stayed hidden for seconds
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
  // the refusal guard's hold first, then the wait for the exit that would confirm the diagnostic
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
        expect(pane.painted()).toBe(query + setup);
        expect(pane.ready()).toBe(true);
        expect(pane.writes).toEqual([]);
        // the stream is a channel on the server's hc connection: no process, so no herdr socket to leak
        expect(pane.pty).toBeUndefined();
        expect(pane.core).toMatchObject({ terminal: "term_0", cols: 80, rows: 24 });
      } else {
        expect(pane.painted()).toBe("");
        expect(pane.ready()).toBe(false);
        expect(pane.writes).toEqual(["\x1b[?1;2c"]);
        expect(pane.pty?.env).toEqual({ HERDR_SOCKET_PATH: herdr.herdrSocketPath() });
        expect(pane.pty?.args).toEqual(["terminal", "attach", "term_0"]);
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

// an SSH PC's bridge starts no runtime (remote-entry.ts): an OVIS_RUNTIME its shell exports names what was
// chosen somewhere, not what this process serves, and its panes are herdr's
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

// #2289: a resized attach goes out on herdr's screen at the pty's grid, not on an older one
for (const ordering of ["a resize back to the start size", "a redraw later than the hold", "a screen queued from before a round trip"] as const) {
  it(`keeps a resized attach held until herdr draws the current grid: ${ordering}`, async () => {
    using pane = await resizableAttach();
    const { attach, ready, painted, resize } = pane;
    await resize(91, 27);
    let current = herdrScreen(91, 27, "current");
    if (ordering === "a screen queued from before a round trip") {
      await resize(80, 24);
      // #2289 review: one read brings herdr's first screen, drawn before both resizes, and the redraw for the grid between them
      // the redraw for the grid between leaves the cursor at column 1, one more move to a row's start
      attach.onData(herdrScreen(80, 24, "old", true) + herdrScreen(91, 27, "between").replaceAll("\x1b[1;8H", "\x1b[2;1H"));
      expect(ready()).toBe(false);
      current = herdrScreen(80, 24, "current");
    } else {
      // herdr's first screen is still the grid the attach started at
      attach.onData(herdrScreen(80, 24, "old", true));
      expect(ready()).toBe(false);
      if (ordering === "a resize back to the start size") {
        await resize(80, 24);
        // the redraw for the 91x27 grid comes before the one for 80x24
        attach.onData(herdrScreen(91, 27, "between"));
        expect(ready()).toBe(false);
        current = herdrScreen(80, 24, "current");
      } else {
        // the hold's own time runs out before the redraw
        jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS);
        expect(ready()).toBe(false);
        expect(painted()).toBe("");
      }
    }
    // in reads cut anywhere, its sequences too: only the update's end makes it a whole screen
    const end = current.indexOf("\x1b[?2026l") + "\x1b[?2026l".length;
    for (let at = 0; at < current.length; at += 5) {
      expect([at, ready()]).toEqual([at, false]);
      attach.onData(current.slice(at, at + 5));
      if (at + 5 >= end) break;
    }
    expect(ready()).toBe(true);
    attach.onData(current.slice(Math.ceil(end / 5) * 5));
    // past the window where a line that may be herdr's refusal waits (here the final "h" of ESC [?25h)
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
  // no attach stays held: past the wait, the screen herdr drew goes out as it did before
  jest.advanceTimersByTime(1);
  expect(pane.ready()).toBe(true);
});

for (const late of [false, true]) {
  it(`lets a resized attach go before a busy pane's held output is too much for one frame, ${late ? "after" : "in"} the hold (#2289 review)`, async () => {
    using pane = await resizableAttach();
    await pane.resize(91, 27);
    pane.attach.onData(herdrScreen(80, 24, "old", true));
    if (late) jest.advanceTimersByTime(terminalProcess.ATTACH_HOLD_MS);
    // the program keeps drawing at the old grid while herdr's redraw is late
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
  // a top row repainted at once: an update from row 1 that is no grid the pty had
  pane.attach.onData(`${herdrScreen(91, 27, "current")}\x1b[?2026h\x1b[1;1H${"x".repeat(91)}\x1b[?2026l`);
  expect(pane.ready()).toBe(true);
});

it("marks a newcomer recovering after a ready stream ends and clears it when the next attach takes", async () => {
  // Given the real process lifecycle, with only its PTY and herdr lookup controlled.
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

    // When a ready stream ends, a newcomer joins before its replacement takes.
    first.onExit(0);
    await registry.terminalFrames.attach(recovering.client, attach);
    // Then the real lifecycle marks the retained screen as recovering, without readiness.
    expect(recovering.frames.filter((frame) => ["output-recovering", "pty-data", "input-ready"].includes(frame.type))).toEqual([
      { type: "output-recovering", pane_id: "p" },
      { type: "pty-data", pane_id: "p", data: "retained screen", replay: true },
    ]);

    // When herdr supplies the replacement terminal and its attach takes.
    ready = Promise.withResolvers<void>();
    lookup.resolve(snapshot("new"));
    const next = await restarted.promise;
    expect(next.args).toEqual(["terminal", "attach", "new"]);
    next.onData("current screen");
    await ready.promise;
    await registry.terminalFrames.attach(recovered.client, attach);
    // Then later newcomers get readiness and replay without a stale recovery mark.
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
    // moved while its terminal is still looked up: the new ID waits from now
    registry.paneMoved("A", "B");
    const waitB = retiring?.get("B");
    expect(waitB).toBeDefined();
    created.resolve({
      kind: "pty", ready: true, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay: new ReplayBuffer(1024),
      process: { exited: exited.promise, pause() {}, resume() {}, resize() {}, winch() {}, kill() { killed.push("A"); }, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
    });
    await attaching;
    await Promise.resolve();
    // a second move before the first process exited carries the wait on
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
