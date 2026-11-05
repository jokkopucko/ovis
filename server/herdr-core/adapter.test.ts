import { afterEach, describe, expect, it, jest } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, paneGet, paneRead, paneSendKeys, paneSendText, sessionSnapshot, subscribeEvents, type EventFrame, paneClose, paneMoveToNewTab, tabClose, tabCreate, tabRename, workspaceClose, workspaceCreate, workspaceRename, agentManifests, agentStart, ping } from "../herdr/client.ts";
import { claudeInputDraft, viewportShowsLive } from "../claude-input.ts";
import { paintedScreen, type SeenObserver, startHerdrCoreAdapter } from "./adapter.ts";
import { SeenMarker } from "./seen-label.ts";
import { encodeFrame, FRAME_CLOSE, FRAME_DATA, HcConnection, HcError, type HcTransport, makeFrameReader } from "./connection.ts";
import type { HcTerminal } from "./snapshot.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/** A core behind a fake `hc connect`: answers channel 0 from `handlers` and records every stream write. */
class FakeCore implements HcTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  /** bytes written to each stream channel, and which channels the client closed */
  readonly typed: { channel: number; text: string }[] = [];
  readonly closed: number[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Stream frames bundled with the next RPC response in one pipe read. */
  replyTail: Uint8Array = new Uint8Array(0);
  killed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private endExited!: () => void;
  private plain = true;
  private nextChannel = 1;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame.channel, frame.kind, frame.payload), () => {});

  constructor(readonly handlers: Record<string, Handler>, readonly answerHello = true) {
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.exited = promise;
    this.endExited = () => resolve(null);
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      if (!this.answerHello) return;
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: { generation: 1, framed: true, version: "0.1.14", core: { id: "c1", name: "lab" }, methods: [], features: [] } })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {
    this.killed = true;
    try { this.controller.close(); } catch { /* closed */ }
    this.endExited();
  }

  /** A notification on a stream channel, as hc sends events. */
  notify(channel: number, method: string, params: Record<string, unknown>): void {
    this.data(channel, `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  data(channel: number, text: string): void {
    this.controller.enqueue(encodeFrame(channel, FRAME_DATA, text));
  }

  channel(): number {
    return this.nextChannel++;
  }

  private onFrame(channel: number, kind: number, payload: Uint8Array): void {
    if (channel !== 0) {
      if (kind === FRAME_DATA) this.typed.push({ channel, text: new TextDecoder().decode(payload) });
      if (kind === FRAME_CLOSE) {
        this.closed.push(channel);
        // hc answers a viewer's CLOSE with its own
        this.controller.enqueue(encodeFrame(channel, FRAME_CLOSE, new Uint8Array(0)));
      }
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(payload)) as { id: number; method: string; params: Record<string, unknown> };
    this.calls.push({ method: message.method, params: message.params });
    const handler = this.handlers[message.method];
    const reply = handler
      ? (() => { try { return { result: handler(message.params) }; } catch (error) { return { error: { code: -32000, message: String(error), data: { kind: "not_found" } } }; } })()
      : { error: { code: -32601, message: `no ${message.method}`, data: { kind: "unknown_method" } } };
    this.controller.enqueue(Buffer.concat([encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })), this.replyTail]));
    this.replyTail = new Uint8Array(0);
  }
}

function terminal(address: string, extra: Partial<HcTerminal> = {}): HcTerminal {
  return { address, cols: 100, rows: 30, cwd: "/home/u", state: "live", ...extra };
}

const LAYOUT = { spaces: [{ id: "s1", name: "api", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [{ type: "block", id: "b1", content: { terminal: "t1" } }] } }] }] };

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const EMPTY_LIST = { terminals: [], hidden_finished: 0, machines: [] };

for (const method of ["call", "open"] as const) {
  it(`times out ${method} while hc never answers hello and reconnects on the next call`, async () => {
    const cores: FakeCore[] = [];
    const hc = new HcConnection(() => {
      const core = new FakeCore({ "terminal.list": () => EMPTY_LIST }, cores.length > 0);
      cores.push(core);
      return core;
    });
    jest.useFakeTimers();
    try {
      const pending = method === "call" ? hc.call("terminal.list", {}, 50)
        : hc.open("events.subscribe", {}, { onData() {}, onClose() {} }, 50);
      const failure = pending.then(() => "resolved", (error: unknown) => error instanceof HcError ? error.kind : "unexpected");
      jest.advanceTimersByTime(50);
      expect(cores[0]?.killed).toBe(true);
      expect(await failure).toBe("timeout");
      expect(await hc.call("terminal.list", {}, 50)).toEqual(EMPTY_LIST);
      expect(cores).toHaveLength(2);
    } finally {
      hc.close();
      jest.useRealTimers();
    }
  });
}
async function setup(terminals: HcTerminal[], extra: Record<string, Handler> = {}, observeSeen?: SeenObserver) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
  const socket = join(dir, "herdr.sock");
  const cores: FakeCore[] = [];
  const handlers: Record<string, Handler> = {
    "terminal.list": () => ({ terminals, hidden_finished: 0 }),
    "doc.get": () => ({ value: LAYOUT, version: 1 }),
    "terminal.get": (params) => {
      const found = terminals.find((entry) => entry.address === params["terminal"]);
      if (!found) throw new Error(`no terminal ${String(params["terminal"])}`);
      return found;
    },
    "terminal.attach": () => ({ channel: cores.at(-1)!.channel(), terminal: terminals[0] }),
    "terminal.keys": () => ({ turn: 0 }),
    ...extra,
  };
  const hc = new HcConnection(() => {
    const core = new FakeCore(handlers);
    cores.push(core);
    return core;
  });
  const adapter = await startHerdrCoreAdapter(hc, socket, observeSeen);
  cleanups.push(() => { adapter.stop(); hc.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socket, cores, hc };
}

describe("herdr-core adapter", () => {
  it("refuses a second adapter on a live socket and leaves the first serving", async () => {
    const { socket, hc } = await setup([terminal("t1")]);
    await sessionSnapshot(socket);
    await expect((async () => {
      const second = await startHerdrCoreAdapter(hc, socket);
      cleanups.push(() => second.stop());
    })()).rejects.toThrow();
    expect((await sessionSnapshot(socket)).panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
  });

  it("says it is herdr-core, so the browser offers only what herdr-core can do", async () => {
    const { socket } = await setup([terminal("t1")]);
    expect(await ping(socket)).toEqual({ version: "0.1.14", protocol: 22, terminal_attach: true, runtime: "herdr-core", layout: { rename: false, split: false, move: false } });
  });

  it("offers Ovis's own layout calls only on a core whose Herdr app document was never written", async () => {
    const { socket } = await setup([terminal("t1")], { "doc.get": () => ({ value: null, version: 0 }) });
    expect((await ping(socket)).layout).toEqual({ rename: true, split: false, move: true });
  });

  it("answers herdr's session snapshot with the app's spaces over hc's terminals", async () => {
    const { socket } = await setup([terminal("t1", { status: { app: "claude", state: "blocked" } }), terminal("t2")]);
    const snapshot = await sessionSnapshot(socket);
    expect(snapshot.workspaces.map((w) => w.label)).toEqual(["api", "Other terminals"]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.agent, p.agent_status])).toEqual([["t1", "claude", "blocked"], ["t2", null, "unknown"]]);
  });

  it("types send_text into an attach at the terminal's own grid, and answers once hc took the attach's close", async () => {
    const { socket, cores } = await setup([terminal("t1", { cols: 90, rows: 20 })]);
    await paneSendText("t1", "héllo 한글", socket);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toEqual({ terminal: "t1", cols: 90, rows: 20 });
    expect(core.typed).toEqual([{ channel: 1, text: "héllo 한글" }]);
    expect(core.closed).toEqual([1]);
  });

  it("reads the screen's colors from a watch-only first paint, so Claude's grey suggestion is no draft (#2609)", async () => {
    const rule = "\u2500".repeat(20);
    // as hc 0.1.17 paints a 4-row terminal with history: the history pushed up, a second clear, the
    // screen (Claude's suggestion dim under its own inverse cursor, the cursor row blank), then the
    // win32-input-mode state and the status report
    const paint = `\u0018\u001b[!p\u001b[?2026l\u001b[H\u001b[2Jolder 1\r\nolder 2\u001b[0m\r\n${"\n".repeat(4)}\u001b[H\u001b[2J`
      + `\u001b[?25l\u001b[3g\u001b[9G\u001bH\u001b[H\u001b[0m\u001b[38;2;136;136;136m${rule}\u001b[0m\r\n\u276f\u00a0\u001b[0m\u001b[7md\u001b[0m\u001b[2mo it\u001b[0m\r\n${rule}  \r\n`
      + "\u001b[4;1H\u001b[0m\u001b]2;claude\u001b\\\u001b[?9001l\u001b]7501;state=idle:app=claude-code\u001b\\";
    // hc's text read: each row's trailing spaces trimmed, the blank row dropped, a history line taken in
    const text = `older 2\n${rule}\n\u276f\u00a0do it\n${rule}`;
    const { socket, cores } = await setup([terminal("t1", { rows: 4 })], {
      "terminal.read": () => ({ text, complete: true, how: "screen" }),
      "terminal.attach": () => {
        const core = cores.at(-1)!;
        const channel = core.channel();
        core.replyTail = encodeFrame(channel, FRAME_DATA, paint);
        return { channel, terminal: terminal("t1", { rows: 4 }) };
      },
    });
    const live = (await paneRead({ paneId: "t1", source: "detection", format: "text" }, socket)).text;
    const colors = (await paneRead({ paneId: "t1", source: "visible", format: "ansi" }, socket)).text;
    expect(colors).toBe(`older 2\u001b[0m\n\u001b[0m\u001b[38;2;136;136;136m${rule}\u001b[0m\n\u276f\u00a0\u001b[0m\u001b[7md\u001b[0m\u001b[2mo it\u001b[0m\n${rule}`);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toEqual({ terminal: "t1", cols: 100, rows: 4, history: 4, observe: true });
    expect(core.closed).toEqual([1]);
    // the chat's box check: herdr-core reports no scroll, so the colors count once their text is the live screen's
    expect(viewportShowsLive(null, null, colors, live, live)).toBe(true);
    expect(claudeInputDraft(live, colors)).toBe(false);
  });

  it("answers a colored read with hc's plain text when the watch-only attach brings no screen", async () => {
    for (const ends of [true, false]) {
      const { socket, cores } = await setup([terminal("t1", { rows: 4 })], {
        "terminal.read": () => ({ text: "\u276f do it", complete: true, how: "screen" }),
        "terminal.attach": () => {
          const core = cores.at(-1)!;
          const channel = core.channel();
          // the terminal ended before painting, or hc sends nothing at all
          if (ends) core.replyTail = encodeFrame(channel, FRAME_CLOSE, JSON.stringify({ reason: "exited" }));
          return { channel, terminal: terminal("t1", { rows: 4 }) };
        },
      });
      expect((await paneRead({ paneId: "t1", source: "visible", format: "ansi" }, socket)).text).toBe("\u276f do it");
      // a stream hc ended is gone already; one still open is closed
      expect(cores[0]!.closed).toEqual(ends ? [] : [1]);
    }
  });

  it("keeps a trailing space drawn in a color, as OpenCode draws the space Tab typed after a skill", () => {
    const paint = "\u001b[H\u001b[2J@effect\u001b[38;5;4m \u001b[48;5;0m  \u001b[0m\r\ntyped \u001b[0m\u001b[7m \u001b[0m\r\n\u001b[?9001l";
    expect(paintedScreen(paint, 3)).toBe("@effect\u001b[38;5;4m \u001b[48;5;0m  \u001b[0m\ntyped\u001b[0m\u001b[7m\u001b[0m");
  });

  it("presses keys in order: typed runs together, runs of mode-dependent keys through hc's encoder", async () => {
    const { socket, cores } = await setup([terminal("t1")]);
    await paneSendKeys("t1", ["Escape", "ctrl+shift+left", "x", "alt+|", "Enter", "c-c", "alt+x"], socket);
    const core = cores[0]!;
    expect(core.typed.map((write) => write.text)).toEqual(["x\x1b|\r"]);
    expect(core.calls.filter((call) => call.method === "terminal.keys").map((call) => call.params["keys"])).toEqual([
      ["escape", "ctrl+shift+left"],
      ["ctrl+c", "alt+x"],
    ]);
    const order = core.calls.map((call) => call.method).filter((method) => method === "terminal.attach" || method === "terminal.keys");
    expect(order).toEqual(["terminal.keys", "terminal.attach", "terminal.keys"]);
  });

  it("replaces a socket file a killed server left behind", async () => {
    const { hc } = await setup([terminal("t1")]);
    const dir = mkdtempSync(join(tmpdir(), "ovis-hc-dead-"));
    const dead = join(dir, "herdr.sock");
    // a server that was killed and left its socket file behind
    const gone = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(dead)}, socket: { data() {} } }); console.log("up")`], { stdout: "pipe" });
    await gone.stdout.getReader().read();
    gone.kill("SIGKILL");
    await gone.exited;
    expect(existsSync(dead)).toBe(true);
    const adapter = await startHerdrCoreAdapter(hc, dead);
    cleanups.push(() => { adapter.stop(); rmSync(dir, { recursive: true, force: true }); });
    expect((await sessionSnapshot(dead)).panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
  });

  it("refuses what only the Herdr app does, and a pane hc does not have, in herdr's codes", async () => {
    const { socket } = await setup([terminal("t1")]);
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(await failure(herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket))).toBe("unsupported");
    // the Herdr app arranges this core (its document is written): its names and places are its own
    expect(await failure(workspaceRename("s1", "x", socket))).toBe("unsupported");
    expect(await failure(tabRename("s1t1", "x", socket))).toBe("unsupported");
    expect(await failure(paneMoveToNewTab("t1", "hc-other", null, socket))).toBe("unsupported");
    expect(await failure(herdrRpc("tab.move", { tab_id: "s1t1", insert_index: 0 }, socket))).toBe("unsupported");
    expect(await failure(paneGet("t9", socket))).toBe("pane_not_found");
    expect(await failure(paneSendText("t9", "x", socket))).toBe("pane_not_found");
  });

  it("tells nothing about another hc machine's terminals and types into none of them (#2768)", async () => {
    let channel = 0;
    const typed: unknown[] = [];
    const { socket, cores } = await setup([terminal("t1"), terminal("vps/t2")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [terminal("vps/t2", { status: { app: "codex", state: "idle" } })] };
      },
      "terminal.attach": (params) => { typed.push(params["terminal"]); return { channel: cores.at(-1)!.channel(), terminal: terminal("vps/t2") }; },
    });
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(await failure(paneSendText("vps/t2", "x", socket))).toBe("pane_not_found");
    expect(typed).toEqual([]);
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.created" }, { type: "layout.updated" }, { type: "pane.agent_status_changed", pane_id: "vps/t2" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores.at(-1)!;
    core.notify(channel, "event", { seq: 2, type: "created", terminal: "vps/t3", data: { address: "vps/t3", state: "live", turn: 0, labels: { "herdr.space": "spcRemote" } } });
    core.notify(channel, "event", { seq: 3, type: "status", terminal: "vps/t2", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "event", { seq: 4, type: "labels", terminal: "vps/t2", data: { labels: { "herdr.seen": "0" } } });
    core.notify(channel, "event", { seq: 5, type: "finished", terminal: "vps/t2", data: { reason: "exited", exit_code: 0 } });
    // the other machine's own Herdr app document, as hc tells it: its machine, no terminal
    core.notify(channel, "event", { seq: 6, type: "doc", machine: "vps", data: { name: "herdr-app", version: 1 } });
    core.notify(channel, "event", { seq: 7, type: "created", terminal: "t4", data: { address: "t4", state: "live", turn: 0 } });
    core.notify(channel, "missed", { seq: 8, terminals: [] });
    await ended.promise;
    // this PC's own new terminal still comes through, after the other machine's events that came first
    expect(frames).toEqual([{ event: "pane.created", data: { type: "pane_created", pane_id: "t4" } }]);
  });

  it("streams status for the subscribed panes only, a finish as herdr's exit and close (a kill as a close alone), and ends on hc's missed", async () => {
    let channel = 0;
    const { socket, cores } = await setup([terminal("t1"), terminal("t2")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t2", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "event", { seq: 3, type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "working" } } });
    core.notify(channel, "event", { seq: 4, type: "status", terminal: "t1", data: { status: { app: "omp", state: "error" } } });
    core.notify(channel, "event", { seq: 5, type: "title", terminal: "t1", data: { title: "spinner" } });
    core.notify(channel, "event", { seq: 6, type: "finished", terminal: "t1", data: { reason: "exited", exit_code: 0 } });
    // a terminal.kill (the Herdr app closing its tab) is herdr's pane.close: closed, never exited
    core.notify(channel, "event", { seq: 7, type: "finished", terminal: "t2", data: { reason: "killed", exit_code: null, signal: 1 } });
    core.notify(channel, "missed", { seq: 9, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      // herdr-core's `claude-code` reaches the browser as herdr's `claude`, as in the snapshot
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "claude" } },
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "unknown", agent: "omp" } },
      { event: "pane.exited", data: { type: "pane_exited", pane_id: "t1" } },
      { event: "pane.closed", data: { type: "pane_closed", pane_id: "t1" } },
      { event: "pane.closed", data: { type: "pane_closed", pane_id: "t2" } },
    ]);
    // the subscription that ended lets go of hc's stream too
    expect(core.closed).toContain(channel);
  });

it("asks for a fresh snapshot when a report's kind, message or progress changes, and only then", async () => {
    let channel = 0;
    const { socket, cores } = await setup([terminal("t1")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    const status = (seq: number, status: Record<string, unknown>) => core.notify(channel, "event", { seq, type: "status", terminal: "t1", data: { status } });
    status(2, { app: "codex", state: "working" });
    status(3, { app: "codex", state: "blocked", kind: "permission", msg: "Allow bash?" });
    status(4, { app: "codex", state: "blocked", kind: "permission", msg: "Allow bash?" });
    status(5, { app: "codex", state: "working", progress: 40 });
    // the same percent, and a message and kind nobody is shown (not blocked): no news
    status(6, { app: "codex", state: "working", progress: 40, msg: "Reading files", kind: "question" });
    // the row prints the exact percent: one more is news
    status(61, { app: "codex", state: "working", progress: 41 });
    status(7, { app: "codex", state: "idle" });
    core.notify(channel, "missed", { seq: 8, terminals: [] });
    await ended.promise;
    const updated = { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } };
    expect(frames).toEqual([updated, updated, updated, updated]);
  });

  it("hears a message or progress that was there as the stream started go away", async () => {
    let channel = 0;
    const { socket, cores } = await setup([terminal("t1")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [{ ...terminal("t1"), status: { app: "codex", state: "blocked", kind: "permission", msg: "Allow bash?" } }] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t1", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "missed", { seq: 3, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([{ event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } }]);
  });

  it("acknowledges before an event bundled with the hc subscribe response", async () => {
    const { socket, cores } = await setup([terminal("t1")], {
      "events.subscribe": () => ({ channel: cores[0]!.channel(), seq: 1, terminals: [] }),
    });
    await sessionSnapshot(socket);
    cores[0]!.replyTail = encodeFrame(1, FRAME_DATA, `${JSON.stringify({ method: "event", params: { type: "created", terminal: "t1" } })}\n`);
    const order: (string | undefined)[] = [];
    const received = Promise.withResolvers<EventFrame>();
    const subscription = subscribeEvents([{ type: "pane.created" }], {
      onStarted: () => order.push("ack"),
      onEvent: (event) => { order.push(event.event); received.resolve(event); },
      onError: (error) => received.reject(error),
    }, socket);
    cleanups.push(() => subscription.close());
    expect(await received.promise).toEqual({ event: "pane.created", data: { type: "pane_created", pane_id: "t1" } });
    expect(order).toEqual(["ack", "pane.created"]);
  });

  it("tells a finish past herdr.seen as done on its turn, and a look from any client as idle", async () => {
    let channel = 0;
    const working = { app: "claude-code", state: "working" };
    const observed: [string, number, string | undefined][] = [];
    const { socket, cores } = await setup([terminal("t1"), terminal("t2")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [terminal("t1", { status: working, turn: 1, labels: { "herdr.seen": "1" } }), terminal("t2", { status: working, turn: 4 })] };
      },
    }, (address, turn, labels) => observed.push([address, turn, labels["herdr.seen"]]));
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const told = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.agent_status_changed", pane_id: "t1" }, { type: "pane.agent_status_changed", pane_id: "t2" }], {
      onEvent: (frame) => { frames.push(frame); if (frames.length === 6) told.resolve(); },
      onStarted: () => started.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    const idle = { status: { app: "claude-code", state: "idle" } };
    // a turn ends: the status first, then the turn that counts it
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t1", data: idle });
    core.notify(channel, "event", { seq: 3, type: "turn", terminal: "t1", data: { turn: 2, state: "idle" } });
    // the Herdr app showed it to someone
    core.notify(channel, "event", { seq: 4, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "2" } } });
    // a label that changes nothing it shows tells nothing
    core.notify(channel, "event", { seq: 5, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "2", "herdr.pinned": "1" } } });
    // marked unread elsewhere
    core.notify(channel, "event", { seq: 6, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "1" } } });
    // no label: a turn that ended since the server first saw it is done, until someone looks
    core.notify(channel, "event", { seq: 7, type: "status", terminal: "t2", data: idle });
    core.notify(channel, "event", { seq: 8, type: "turn", terminal: "t2", data: { turn: 5, state: "idle" } });
    core.notify(channel, "event", { seq: 9, type: "labels", terminal: "t2", data: { labels: { "herdr.seen": "5" } } });
    core.notify(channel, "event", { seq: 10, type: "status", terminal: "t2", data: { status: working } });
    await told.promise;
    const shown = (pane: string, status: string) => ({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: status, agent: "claude" } });
    expect(frames).toEqual([shown("t1", "done"), shown("t1", "idle"), shown("t1", "done"), shown("t2", "done"), shown("t2", "idle"), shown("t2", "working")]);
    // what the server's seen marker learns: each terminal's turn and herdr.seen, as they change
    expect(observed).toEqual([["t1", 1, "1"], ["t2", 4, undefined], ["t1", 2, "1"], ["t1", 2, "2"], ["t1", 2, "2"], ["t1", 2, "1"], ["t2", 5, undefined], ["t2", 5, "5"]]);
  });

  it("marks a terminal seen at its turn, only to raise it or where it is missing, once per turn unless it is shown again", async () => {
    const terminals = [
      terminal("t1", { turn: 3, labels: { "herdr.seen": "1" } }),
      terminal("t2", { turn: 3, labels: { "herdr.seen": "3" } }),
      terminal("t3", { turn: 2 }),
      terminal("t4", { turn: 5, state: "finished" }),
      terminal("t5", { turn: 3, labels: { "herdr.seen": "3" } }),
    ];
    const written: unknown[] = [];
    const { hc } = await setup(terminals, { "terminal.label": (params) => { written.push(params); return terminals[0]; } });
    const marker = new SeenMarker(hc);
    for (const address of ["t1", "t2", "t3", "t4"]) await marker.mark(address);
    // another client marks t1 unread while it is still on screen here: this turn is not written again
    terminals[0]!.labels = { "herdr.seen": "2" };
    await marker.mark("t1");
    // a person coming back to it later raises it again
    await marker.mark("t1", true);
    // t2 was read elsewhere first: marked unread while on screen here, it stays unread
    terminals[1]!.labels = { "herdr.seen": "2" };
    await marker.mark("t2");
    // t5 was read elsewhere while idle in front here (Ovis was told of no look): the same
    marker.observe("t5", 3, { "herdr.seen": "3" });
    terminals[4]!.labels = { "herdr.seen": "2" };
    await marker.mark("t5");
    // and coming back to it raises it again
    await marker.mark("t5", true);
    // the next turn is
    terminals[0]!.turn = 4;
    await Promise.all([marker.mark("t1"), marker.mark("t1")]);
    expect(written).toEqual([
      { terminal: "t1", labels: { "herdr.seen": "3" } },
      { terminal: "t3", labels: { "herdr.seen": "2" } },
      { terminal: "t1", labels: { "herdr.seen": "3" } },
      { terminal: "t5", labels: { "herdr.seen": "3" } },
      { terminal: "t1", labels: { "herdr.seen": "4" } },
    ]);
  });

  it("shows a turn ended since it first saw an unlabeled terminal as done in the snapshot, and a look elsewhere as idle", async () => {
    const t1 = terminal("t1", { status: { app: "claude-code", state: "idle" }, turn: 2 });
    const { socket } = await setup([t1]);
    expect((await sessionSnapshot(socket)).panes[0]!.agent_status).toBe("idle");
    t1.turn = 3;
    expect((await sessionSnapshot(socket)).panes[0]!.agent_status).toBe("done");
    t1.labels = { "herdr.seen": "3" };
    expect((await sessionSnapshot(socket)).panes[0]!.agent_status).toBe("idle");
  });

  it("fails what waited on a line to hc that ended, and opens a new one for the next call", async () => {
    const { socket, cores } = await setup([terminal("t1")]);
    await sessionSnapshot(socket);
    cores[0]!.kill();
    await cores[0]!.exited;
    const snapshot = await sessionSnapshot(socket);
    expect(snapshot.panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
    expect(cores.length).toBe(2);
  });

  for (const newline of ["", "\n"]) {
    it(`closes an oversized event line across frames ${newline ? "with" : "without"} a newline with an error`, async () => {
      let channel = 0;
      const { socket, cores } = await setup([terminal("t1")], {
        "events.subscribe": () => {
          channel = cores.at(-1)!.channel();
          return { channel, seq: 1, terminals: [] };
        },
      });
      const started = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const errors: Error[] = [];
      const frames: EventFrame[] = [];
      const subscription = subscribeEvents([{ type: "pane.created" }], {
        onStarted: () => started.resolve(),
        onClose: () => ended.resolve(),
        onError: (error) => errors.push(error),
        onEvent: (event) => frames.push(event),
      }, socket);
      cleanups.push(() => subscription.close());
      await started.promise;
      const core = cores[0]!;
      core.data(channel, " ".repeat(3 * 1024 * 1024));
      core.data(channel, " ".repeat(1024 * 1024 + 1) + newline);
      await ended.promise;
      expect(errors.map((error) => error instanceof HerdrError ? error.code : error.name)).toEqual(["bad_frame"]);
      expect(frames).toEqual([]);
      expect(core.closed).toEqual([channel]);
    });
  }

describe("herdr-core adapter, new and closed terminals", () => {
  /** a core whose terminal list follows its own terminal.run, terminal.kill and terminal.rm */
  async function living(start: HcTerminal[], extra: Record<string, Handler> = {}) {
    const terminals = [...start];
    const runs: Record<string, unknown>[] = [];
    const ends: string[] = [];
    let next = terminals.length + 1;
    const ready = await setup(terminals, {
      "terminal.run": (params) => {
        runs.push(params);
        const record = terminal(`t${next++}`, { cwd: typeof params["cwd"] === "string" ? params["cwd"] : "/home/u", labels: params["labels"] as Record<string, string> });
        terminals.push(record);
        return record;
      },
      "terminal.kill": (params) => {
        ends.push(`kill ${String(params["terminal"])}`);
        const found = terminals.find((entry) => entry.address === params["terminal"]);
        if (!found) throw new Error("no terminal");
        found.state = "finished";
        return found;
      },
      "terminal.rm": (params) => {
        ends.push(`rm ${String(params["terminal"])}`);
        terminals.splice(terminals.findIndex((entry) => entry.address === params["terminal"]), 1);
        return { removed: params["terminal"] };
      },
      ...extra,
    });
    return { ...ready, runs, ends };
  }
  /** a core no Herdr app arranges: its layout document was never written */
  const NO_DOC = { "doc.get": () => ({ value: null, version: 0 }) };

  it("keeps a renamed workspace's name on a new tab, so it stays when the tab it was given in closes", async () => {
    const { socket, runs } = await living([terminal("t1", { labels: { "herdr.space": "S", "herdr.tab": "T", "ovis.workspace": "Named" } })], NO_DOC);
    await tabCreate({ workspaceId: "S" }, socket);
    expect(runs[0]!["labels"]).toMatchObject({ "herdr.space": "S", "ovis.workspace": "Named" });
    await tabClose("T", socket);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.label)).toEqual(["Named"]);
  });

  it("refuses to move a helper to Other terminals, where its parent's tab would still show it", async () => {
    const { socket } = await living([terminal("t1", { labels: { "herdr.space": "S", "herdr.tab": "T" } }), terminal("t2", { parent: "t1" }), terminal("t3")], NO_DOC);
    await expect(paneMoveToNewTab("t2", "hc-other", null, socket)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("splits no pane, even where Ovis keeps the layout: its panes would size each other down", async () => {
    const { socket, runs } = await living([terminal("t1", { labels: { "herdr.space": "S", "herdr.tab": "T" } })], NO_DOC);
    await expect(herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(runs).toEqual([]);
  });

  it("starts a new workspace as a kept shell labeled with a space and tab of its own, named as asked", async () => {
    const { socket, runs } = await living([terminal("t1")]);
    const created = await workspaceCreate({ cwd: "/work/web", label: "web" }, socket);
    const labels = runs[0]!["labels"] as Record<string, string>;
    expect(runs[0]).toMatchObject({ keep: true, cwd: "/work/web" });
    expect(labels["herdr.space"]).toMatch(/^ovis-/);
    expect(labels["herdr.tab"]).toMatch(/^ovis-/);
    expect(labels["ovis.workspace"]).toBe("web");
    // nothing has finished in a terminal a client starts (herdr-app docs/labels.md)
    expect(labels["herdr.seen"]).toBe("0");
    expect(created.workspace).toMatchObject({ workspace_id: labels["herdr.space"], label: "web" });
    expect(created.tab).toMatchObject({ tab_id: labels["herdr.tab"], workspace_id: labels["herdr.space"] });
    expect(created.root_pane).toMatchObject({ pane_id: "t2", terminal_id: "t2", tab_id: labels["herdr.tab"] });
  });

  it("starts a new tab in the app's space, where that space's first pane works, and one in Other terminals on its own", async () => {
    const { socket, runs } = await living([terminal("t1", { cwd: "/repo/api" })]);
    const tab = await tabCreate({ workspaceId: "s1", label: "logs" }, socket);
    expect(runs[0]).toMatchObject({ keep: true, cwd: "/repo/api" });
    expect(runs[0]!["labels"]).toMatchObject({ "herdr.space": "s1", "ovis.tab": "logs" });
    expect(tab.tab).toMatchObject({ workspace_id: "s1", label: "logs" });
    expect(tab.root_pane.pane_id).toBe("t2");
    await tabCreate({ workspaceId: "hc-other" }, socket);
    expect(runs[1]!["labels"]).toEqual({ "herdr.seen": "0" });
    await expect(tabCreate({ workspaceId: "nope" }, socket)).rejects.toMatchObject({ code: "workspace_not_found" });
  });

  it("closes a pane, a tab or a workspace by ending each of its terminals and removing its record", async () => {
    const { socket, ends } = await living([terminal("t1"), terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "s1t2" } }), terminal("t3")]);
    await paneClose("t3", socket);
    expect(ends).toEqual(["kill t3", "rm t3"]);
    await tabClose("s1t2", socket);
    expect(ends.slice(2)).toEqual(["kill t2", "rm t2"]);
    await workspaceClose("s1", socket);
    expect(ends.slice(4)).toEqual(["kill t1", "rm t1"]);
    expect((await sessionSnapshot(socket)).panes).toEqual([]);
    await expect(paneClose("t9", socket)).rejects.toMatchObject({ code: "pane_not_found" });
  });

  it("closes only a tab's own terminal when labels name the same ids in other spaces", async () => {
    // t1 is the app's own (the layout document places it); t5 to t7 are labeled only
    const { socket, ends } = await living([
      terminal("t1"),
      terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t6", { labels: { "herdr.space": "T" } }),
      terminal("t7", { labels: { "herdr.space": "Y", "herdr.tab": "T" } }),
    ]);
    await tabClose("T", socket);
    expect(ends).toEqual(["kill t5", "rm t5"]);
  });

  it("refuses to close Other terminals as a whole: its jobs and agents' workers are no workspace's", async () => {
    const { socket, ends } = await living([terminal("t1"), terminal("t5")]);
    await expect(workspaceClose("hc-other", socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(ends).toEqual([]);
  });

  it("ends every terminal of a closed workspace at once, and answers a failure only after trying them all", async () => {
    const kills: string[] = [];
    const held = Promise.withResolvers<void>();
    const terminals = [terminal("t1"), terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "s1t2" } })];
    const { socket } = await setup(terminals, {
      "terminal.kill": (params) => {
        kills.push(String(params["terminal"]));
        if (kills.length === 2) held.resolve();
        if (params["terminal"] === "t1") throw new Error("kill refused");
        return {};
      },
      "terminal.rm": () => ({}),
    });
    await expect(workspaceClose("s1", socket)).rejects.toMatchObject({ message: expect.stringContaining("kill refused") });
    await held.promise;
    expect(kills.sort()).toEqual(["t1", "t2"]);
  });
});

describe("herdr-core adapter, agents", () => {
  it("starts an agent by typing its kind and quoted arguments into the pane's idle shell, and answers once it is in front", async () => {
    const shell = { pid: 10, name: "bash" };
    const agent = { pid: 11, name: "claude" };
    const record = terminal("t1", { cols: 90, rows: 20, pid: 10, argv: ["/bin/bash"], foreground: shell });
    const { socket, cores } = await setup([record], {
      // hc's foreground: the shell until the line was typed, then the agent
      "terminal.get": () => ({ ...record, foreground: cores[0]!.typed.length > 0 ? agent : shell }),
    });
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--model", "it's big"] }, socket);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toMatchObject({ terminal: "t1", cols: 90, rows: 20 });
    expect(core.typed.map((write) => write.text).join("")).toBe("\u0015'claude' '--model' 'it'\\''s big'\r");
    // it looked again after typing: the answer follows what hc saw in front
    const methods = core.calls.map((call) => call.method);
    expect(methods.lastIndexOf("terminal.get")).toBeGreaterThan(methods.indexOf("terminal.attach"));
  });

  it("counts an agent run through its interpreter as started, and a shell's command-not-found handler as a failed start", async () => {
    const shell = { pid: 10, name: "bash" };
    // hc's foreground: the shell until the line is typed, then each later look sees the next one
    const sequence = (after: { pid: number; name: string; argv?: string[] }[]) => {
      const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
      const holder: { cores: FakeCore[] } = { cores: [] };
      let seen = 0;
      const get = () => ({ ...record, foreground: holder.cores[0]?.typed.length ? after[Math.min(seen++, after.length - 1)] : shell });
      return { record, holder, get };
    };
    const node = sequence([{ pid: 11, name: "node", argv: ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"] }]);
    const started = await setup([node.record], { "terminal.get": node.get });
    node.holder.cores = started.cores;
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, started.socket);
    const missing = sequence([{ pid: 12, name: "python3", argv: ["/usr/bin/python3", "/usr/lib/command-not-found", "--", "amp"] }, shell]);
    const failed = await setup([missing.record], { "terminal.get": missing.get });
    missing.holder.cores = failed.cores;
    await expect(agentStart({ name: "amp-1", kind: "amp", paneId: "t1" }, failed.socket)).rejects.toMatchObject({ code: "agent_start_failed" });
  });

  it("lets what is typed after a start reach the pane while the start waits for its agent", async () => {
    const shell = { pid: 10, name: "bash" };
    const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
    const holder: { cores: FakeCore[]; agentUp: boolean } = { cores: [], agentUp: false };
    const ready = await setup([record], { "terminal.get": () => ({ ...record, foreground: holder.agentUp ? { pid: 11, name: "claude" } : shell }) });
    holder.cores = ready.cores;
    const starting = agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, ready.socket);
    let started = false;
    void starting.then(() => { started = true; });
    // typed while the agent is not in front yet: it goes in, and the start is still waiting
    await paneSendText("t1", "hi", ready.socket);
    expect(holder.cores[0]!.typed.map((write) => write.text)).toContain("hi");
    expect(started).toBe(false);
    holder.agentUp = true;
    await starting;
  });

  it("types Cursor's agent command, not the IDE's, and waits for it in front", async () => {
    const shell = { pid: 10, name: "bash" };
    const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
    const holder: { cores: FakeCore[] } = { cores: [] };
    const ready = await setup([record], { "terminal.get": () => ({ ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "cursor-agent" } : shell }) });
    holder.cores = ready.cores;
    await agentStart({ name: "cursor-1", kind: "cursor", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'cursor-agent'\r");
  });

  it("refuses a pane with a program in front, a kind that is no command, and an argument with a control character", async () => {
    const { socket, cores } = await setup([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 12, name: "vim" } })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "x", kind: "rm -rf /", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", args: ["a\u0015touch /tmp/x\r"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t9" }, socket)).rejects.toMatchObject({ code: "pane_not_found" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("types into no pane whose own program is not a shell, even with that program in front of itself", async () => {
    // a terminal the app started as a program: hc reports it in front of itself, like a shell
    const { socket, cores } = await setup([
      terminal("t1", { pid: 10, argv: ["claude"], foreground: { pid: 10, name: "claude", argv: ["claude"] } }),
      // a template or a line: dash runs it as its child and stays in front under its own pid
      terminal("t2", { pid: 20, argv: ["sh", "-c", "claude"], foreground: { pid: 20, name: "sh", argv: ["sh", "-c", "claude"] } }),
    ]);
    // never a shell to start in: refused at once, not retried as a busy one
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    await expect(agentStart({ name: "y", kind: "codex", paneId: "t2" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("types into no shell that exec'd a non-plain shell, and checks fish's quoting on the shell in front", async () => {
    const { socket, cores } = await setup([
      terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "bash", argv: ["bash", "-c", "read line"] } }),
      terminal("t2", { pid: 20, argv: ["/bin/bash"], foreground: { pid: 20, name: "fish", argv: ["fish"] } }),
    ]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", timeoutMs: 300 }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "y", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("refuses a backslash fish would read differently", async () => {
    const fish = { pid: 20, name: "fish", argv: ["/usr/bin/fish"] };
    const { socket, cores } = await setup([terminal("t2", { pid: 20, argv: ["/usr/bin/fish"], foreground: fish })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("starts in a login shell", async () => {
    const login = { pid: 10, name: "zsh", argv: ["-zsh", "-l"] };
    const record = terminal("t1", { pid: 10, argv: ["-zsh", "-l"], foreground: login });
    const holder: { cores: FakeCore[] } = { cores: [] };
    const ready = await setup([record], { "terminal.get": () => ({ ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "claude" } : login }) });
    holder.cores = ready.cores;
    await agentStart({ name: "y", kind: "claude", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'claude'\r");
  });

  it("types into no shell that has become another program with exec, its pid unchanged", async () => {
    const { socket, cores } = await setup([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "claude", argv: ["claude"] } })]);
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("offers the agents Ovis knows by kind, leaving the ones Ovis starts itself to the server", async () => {
    const { socket } = await setup([terminal("t1")]);
    const kinds = (await agentManifests(socket)).manifests.map((manifest) => manifest.agent);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
    expect(kinds).not.toContain("omo");
  });
});
});
