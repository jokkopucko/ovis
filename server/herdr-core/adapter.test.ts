import { afterEach, describe, expect, it, jest, setSystemTime } from "bun:test";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, paneGet, paneProcessInfo, paneRead, paneSendKeys, paneSendText, sessionSnapshot, subscribeEvents, type EventFrame, paneClose, paneMoveBeside, paneMoveToNewTab, tabClose, tabCreate, tabMove, tabRename, workspaceClose, workspaceCreate, workspaceRename, agentManifests, agentStart, ping, worktreeCreate, worktreeList, worktreeOpen, worktreeRemove } from "../herdr/client.ts";
import { claudeInputDraft, viewportShowsLive } from "../claude-input.ts";
import { type AdapterOptions, paintedScreen, type SeenObserver, sessionLabeler, startHerdrCoreAdapter } from "./adapter.ts";
import { SeenMarker } from "./seen-label.ts";
import { encodeFrame, FRAME_CLOSE, FRAME_DATA, HcConnection, HcError, type HcTransport, makeFrameReader } from "./connection.ts";
import { MachineScopedConnection } from "./machine-scope.ts";
import { adapterAddress } from "./pipe.ts";
import { parseCheckouts } from "./worktrees.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { ProcessRow } from "../windows-processes.ts";
import type { HcTerminal } from "./snapshot.ts";

type Handler = (params: Record<string, unknown>) => unknown;

class FakeCore implements HcTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  readonly typed: { channel: number; text: string }[] = [];
  readonly closed: number[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
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
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: { generation: 1, framed: true, version: "0.1.14", core: { id: "c1", name: "lab" }, methods: Object.keys(this.handlers), features: [] } })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {
    this.killed = true;
    try { this.controller.close(); } catch { }
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
      ? (() => { try { return { result: handler(message.params) }; } catch (error) { return { error: { code: -32000, message: String(error), data: { kind: (error as { kind?: string }).kind ?? "not_found" } } }; } })()
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
async function setup(terminals: HcTerminal[], extra: Record<string, Handler> = {}, observeSeen?: SeenObserver, machine?: string, pc: Pick<AdapterOptions, "platform" | "processTable" | "terminalEnv"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
  const socket = join(dir, "herdr.sock");
  const cores: FakeCore[] = [];
  const handlers: Record<string, Handler> = {
    "terminal.list": () => ({ terminals, hidden_finished: 0 }),
    "doc.get": () => ({ value: LAYOUT, version: 1 }),
    "terminal.get": (params) => {
      // as hc: a machine's id in an address names the same terminal as its name, which the record keeps
      const asked = machine === undefined ? params["terminal"] : String(params["terminal"]).replace(`${machine}-id/`, `${machine}/`);
      const found = terminals.find((entry) => entry.address === asked);
      if (!found) throw new Error(`no terminal ${String(params["terminal"])}`);
      return found;
    },
    "terminal.attach": () => ({ channel: cores.at(-1)!.channel(), terminal: terminals[0] }),
    "terminal.keys": () => ({ turn: 0 }),
    "machine.list": () => ({ machines: machine === undefined ? [] : [{ name: machine, id: `${machine}-id`, host: machine, state: "connected", target: machine, version: "0.1.17" }] }),
    ...extra,
  };
  const spawn = () => {
    const core = new FakeCore(handlers);
    cores.push(core);
    return core;
  };
  const hc = machine === undefined ? new HcConnection(spawn) : new MachineScopedConnection(spawn, machine, `${machine}-id`);
  const opencodeStore = [..."first second third short".split(" ").map((title) => [`ses_${title}`, title]), ["ses_twinA", "twin"], ["ses_twinB", "twin"]];
  const opencodeTitled = (title: string) => opencodeStore.flatMap(([id, named]) => `OC | ${named}` === title ? [id!] : []);
  const adapter = await startHerdrCoreAdapter(hc, socket, observeSeen, { otherMachine: machine !== undefined, opencodeTitled, ...pc });
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
    expect(await ping(socket)).toEqual({ version: "0.1.14", protocol: 22, terminal_attach: true, runtime: "herdr-core", layout: { rename: false, split: false, move: false, arrange: false, worktrees: false } });
  });

  it("offers Ovis's own layout calls only on a core whose Herdr app document was never written", async () => {
    const { socket } = await setup([terminal("t1")], { "doc.get": () => ({ value: null, version: 0 }) });
    expect((await ping(socket)).layout).toEqual({ rename: true, split: false, move: true, arrange: false, worktrees: true });
    // splits, zoom and order need a core that writes documents, as its hello says
    const writes = await setup([terminal("t1")], { "doc.get": () => ({ value: null, version: 0 }), "doc.set": () => ({ version: 1 }) });
    expect((await ping(writes.socket)).layout).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
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

  it("reads no history of a terminal on the alternate screen, which hc would scroll and repaint for every viewer (#3128)", async () => {
    const preamble = "\u0018\u001b[!p\u001b[?2026l\u001b[?1004l\u001b[?1049l\u001b[?1047l\u001b[?47l\u001b[H\u001b[2J";
    for (const shown of ["alternate", "main", "refused"] as const) {
      const full = shown !== "main";
      // as hc 0.1.14 paints with no history: its reset, the alternate screen if the program is on it, the screen
      const paint = `${preamble}${shown === "alternate" ? "\u001b[?1049h" : ""}\u001b[H\u001b[0m\u203a Ask Codex\r\n\u001b[?9001l`;
      const { socket, cores } = await setup([terminal("t1", { rows: 4 })], {
        "terminal.read": (params) => ({ text: params["lines"] ? "older\n\u203a Ask Codex" : "\u203a Ask Codex", complete: true, how: params["lines"] ? "history" : "screen" }),
        "terminal.attach": () => {
          // a kept terminal whose program is lost: hc refuses its attach, yet reads its stored screen
          if (shown === "refused") throw Object.assign(new Error("lost"), { kind: "lost" });
          const core = cores.at(-1)!;
          const channel = core.channel();
          core.replyTail = encodeFrame(channel, FRAME_DATA, paint);
          return { channel, terminal: terminal("t1", { rows: 4 }) };
        },
      });
      const read = await paneRead({ paneId: "t1", source: "recent", lines: 400, stripAnsi: true }, socket);
      const core = cores[0]!;
      expect(core.calls.filter((call) => call.method === "terminal.read").map((call) => call.params["lines"])).toEqual([full ? 0 : 400]);
      expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toEqual({ terminal: "t1", cols: 100, rows: 4, history: 0, observe: true });
      expect(read.text).toBe(full ? "\u203a Ask Codex" : "older\n\u203a Ask Codex");
      expect(read.truncated).toBe(full);
    }
  });

  it("answers a colored read with hc's plain text when the watch-only attach brings no screen", async () => {
    for (const ends of [true, false]) {
      const { socket, cores } = await setup([terminal("t1", { rows: 4 })], {
        "terminal.read": () => ({ text: "\u276f do it", complete: true, how: "screen" }),
        "terminal.attach": () => {
          const core = cores.at(-1)!;
          const channel = core.channel();
          if (ends) core.replyTail = encodeFrame(channel, FRAME_CLOSE, JSON.stringify({ reason: "exited" }));
          return { channel, terminal: terminal("t1", { rows: 4 }) };
        },
      });
      expect((await paneRead({ paneId: "t1", source: "visible", format: "ansi" }, socket)).text).toBe("\u276f do it");
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
    expect(core.closed).toContain(channel);
  });

  // hc 0.1.17 on old-desktop, 2026-11-08: Letta Code reports nothing, and hc tells each new program in front as a `foreground` event
  it("names an agent that reports nothing from the process in front, in its status and as that process changes", async () => {
    let channel = 0;
    const letta = { pid: 11, name: "node", argv: ["node", "/home/u/npm/node_modules/.bin/letta"] };
    const { socket, cores } = await setup([terminal("t1")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [terminal("t1", { argv: ["bash"], foreground: letta })] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated" }, { type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t1", data: { status: { state: "working" } } });
    core.notify(channel, "event", { seq: 3, type: "foreground", terminal: "t1", data: { ...letta, pid: 12 } });
    core.notify(channel, "event", { seq: 4, type: "foreground", terminal: "t1", data: { pid: 13, name: "bash", argv: ["bash"] } });
    core.notify(channel, "event", { seq: 5, type: "foreground", terminal: "t1", data: { pid: 14, name: "devin", argv: ["devin"] } });
    core.notify(channel, "missed", { seq: 9, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "letta" } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: null } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "devin" } },
    ]);
  });

  // letta-code 0.34.44 on old-desktop, 2026-11-08: its title carries a spinner frame while a turn runs
  it("asks for a fresh snapshot when a Letta that reports nothing starts or stops its spinner title, and only then", async () => {
    let channel = 0;
    const letta = { pid: 11, name: "letta", argv: ["letta"] };
    const { socket, cores } = await setup([terminal("t1"), terminal("t2")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [terminal("t1", { foreground: letta, title: "Tutor" }), terminal("t2", { foreground: letta, title: "Tutor", status: { app: "letta", state: "idle" } }), terminal("t3", { foreground: letta, title: "Tutor", status: { app: "letta", state: "error" } })] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated" }], { onEvent: (frame) => frames.push(frame), onStarted: () => started.resolve(), onClose: () => ended.resolve() }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    const title = (seq: number, terminal: string, value: string) => core.notify(channel, "event", { seq, type: "title", terminal, data: { title: value } });
    title(2, "t1", "⠋ Tutor");
    title(3, "t1", "⠙ Tutor");
    title(4, "t1", "Tutor");
    title(5, "t2", "⠋ Tutor");
    title(6, "t3", "⠋ Tutor");
    core.notify(channel, "missed", { seq: 9, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t3" } },
    ]);
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
    status(6, { app: "codex", state: "working", progress: 40, msg: "Reading files", kind: "question" });
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
    core.notify(channel, "event", { seq: 4, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "2" } } });
    core.notify(channel, "event", { seq: 5, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "2", "herdr.pinned": "1" } } });
    core.notify(channel, "event", { seq: 6, type: "labels", terminal: "t1", data: { labels: { "herdr.seen": "1" } } });
    core.notify(channel, "event", { seq: 7, type: "status", terminal: "t2", data: idle });
    core.notify(channel, "event", { seq: 8, type: "turn", terminal: "t2", data: { turn: 5, state: "idle" } });
    core.notify(channel, "event", { seq: 9, type: "labels", terminal: "t2", data: { labels: { "herdr.seen": "5" } } });
    core.notify(channel, "event", { seq: 10, type: "status", terminal: "t2", data: { status: working } });
    await told.promise;
    const shown = (pane: string, status: string) => ({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: status, agent: "claude" } });
    expect(frames).toEqual([shown("t1", "done"), shown("t1", "idle"), shown("t1", "done"), shown("t2", "done"), shown("t2", "idle"), shown("t2", "working")]);
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
    terminals[0]!.labels = { "herdr.seen": "2" };
    await marker.mark("t1");
    await marker.mark("t1", true);
    terminals[1]!.labels = { "herdr.seen": "2" };
    await marker.mark("t2");
    marker.observe("t5", 3, { "herdr.seen": "3" });
    terminals[4]!.labels = { "herdr.seen": "2" };
    await marker.mark("t5");
    await marker.mark("t5", true);
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

  it("binds an OpenCode pane to the named session its terminal title shows, through rest, a background tab, a switch and its exit", async () => {
    const opencode = (state: string) => ({ app: "opencode", state });
    const t1 = terminal("t1", { title: "OC | first", status: opencode("working"), records: { ses_first: opencode("working") } });
    const { socket } = await setup([t1]);
    const session = async () => (await sessionSnapshot(socket)).panes[0]!.agent_session ?? null;
    const reported = (value: string) => ({ agent: "opencode", source: "herdr:opencode", kind: "id", value });
    expect(await session()).toEqual(reported("ses_first"));
    // OpenCode clears a session's record once it rests: the pane still shows it
    t1.status = opencode("idle");
    t1.records = {};
    expect(await session()).toEqual(reported("ses_first"));
    t1.status = opencode("working");
    t1.records = { ses_second: opencode("working") };
    expect(await session()).toEqual(reported("ses_first"));
    t1.status = opencode("idle");
    t1.records = {};
    t1.title = "OC | second";
    expect(await session()).toEqual(reported("ses_second"));
    t1.title = "OpenCode";
    expect(await session()).toBeNull();
    t1.title = "OC | third";
    expect(await session()).toBeNull();
    t1.records = { ses_twinA: opencode("working") };
    t1.title = "OC | twin";
    expect(await session()).toBeNull();
    t1.title = "OC | first";
    t1.status = null;
    expect(await session()).toBeNull();
    t1.status = opencode("idle");
    expect(await session()).toBeNull();
  });

  it("keeps an OpenCode pane's named sessions in its label, so a pane resting through a restart of Ovis still shows its session", async () => {
    const opencode = (state: string) => ({ app: "opencode", state });
    const reported = (value: string) => ({ agent: "opencode", source: "herdr:opencode", kind: "id", value });
    const t1 = terminal("t1", { title: "OC | first", status: opencode("working"), records: { ses_first: opencode("working") } });
    const t2 = terminal("t2", { title: "OC | second", status: opencode("idle"), labels: { "ovis.opencode": "ses_first ses_second" } });
    const t3 = terminal("t3", { title: "OC | third", status: null, labels: { "ovis.opencode": "ses_third" } });
    const terminals = [t1, t2, t3];
    const written: unknown[] = [];
    const waits: { count: number; resolve: () => void }[] = [];
    const writes = (count: number) => new Promise<void>((resolve) => { if (written.length >= count) resolve(); else waits.push({ count, resolve }); });
    const { socket } = await setup(terminals, {
      "terminal.label": (params) => {
        written.push(params);
        for (const wait of waits) if (written.length >= wait.count) wait.resolve();
        return terminals.find((entry) => entry.address === params["terminal"])!;
      },
    });
    const sessions = async () => (await sessionSnapshot(socket)).panes.map((pane) => pane.agent_session ?? null);
    expect(await sessions()).toEqual([reported("ses_first"), reported("ses_second"), null]);
    await writes(2);
    expect(written).toEqual([{ terminal: "t1", labels: { "ovis.opencode": "ses_first" } }, { terminal: "t3", labels: { "ovis.opencode": "" } }]);
    t1.status = null;
    expect(await sessions()).toEqual([null, reported("ses_second"), null]);
    await writes(3);
    expect(written.at(-1)).toEqual({ terminal: "t1", labels: { "ovis.opencode": "" } });
    t3.status = opencode("idle");
    t3.labels = { "ovis.opencode": "ses_third" };
    expect((await sessions())[2]).toBeNull();
  });

  it("keeps in the label every session the pane can still be bound to, not only the newest", async () => {
    const opencode = (state: string) => ({ app: "opencode", state });
    const t1 = terminal("t1", { title: "OC | first", status: opencode("working"), records: {} });
    const written: Record<string, unknown>[] = [];
    const waits: { count: number; resolve: () => void }[] = [];
    const writes = (count: number) => new Promise<void>((resolve) => { if (written.length >= count) resolve(); else waits.push({ count, resolve }); });
    const { socket } = await setup([t1], {
      "terminal.label": (params) => {
        written.push(params);
        for (const wait of waits) if (written.length >= wait.count) wait.resolve();
        return t1;
      },
    });
    const named = Array.from({ length: 9 }, (_, index) => `ses_${index}`);
    for (const id of named) {
      t1.records = { [id]: opencode("working") };
      await sessionSnapshot(socket);
    }
    await writes(9);
    expect(written.at(-1)).toEqual({ terminal: "t1", labels: { "ovis.opencode": named.join(" ") } });
  });

  it("drops an OpenCode label write still queued once stopped, so none opens a line to hc after the server closed it", async () => {
    const written: unknown[] = [];
    const first = Promise.withResolvers<void>();
    const labels = sessionLabeler({
      call: (async (_method: string, params: unknown) => {
        written.push(params);
        if (written.length === 1) await first.promise;
      }) as unknown as HcConnection["call"],
    });
    labels.label("t1", "", ["ses_first"]);
    labels.label("t1", "", ["ses_first", "ses_second"]);
    await Promise.resolve();
    expect(written).toEqual([{ terminal: "t1", labels: { "ovis.opencode": "ses_first" } }]);
    labels.stop();
    first.resolve();
    labels.label("t2", "", ["ses_third"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toHaveLength(1);
  });

  it("remembers an OpenCode session a status event named, for a turn that ended before any snapshot", async () => {
    let channel = 0;
    const t1 = terminal("t1", { title: "OC | short", status: { app: "opencode", state: "idle" } });
    const { socket, cores } = await setup([t1], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [t1] };
      },
    });
    const statuses: unknown[] = [];
    const started = Promise.withResolvers<void>();
    const told = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => { if (statuses.push(frame.data?.["agent_status"]) === 2) told.resolve(); },
      onStarted: () => started.resolve(),
      onClose() {},
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    const pending = { ses_short: { app: "opencode", state: "working" } };
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t1", data: { status: { app: "opencode", state: "working" }, records: pending } });
    core.notify(channel, "event", { seq: 3, type: "status", terminal: "t1", data: { status: { app: "opencode", state: "idle" }, records: {} } });
    core.notify(channel, "event", { seq: 4, type: "status", terminal: "t1", data: { status: { app: "opencode", state: "blocked" }, records: {} } });
    await told.promise;
    expect(statuses).toEqual(["working", "blocked"]);
    expect((await sessionSnapshot(socket)).panes[0]!.agent_session).toEqual({ agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_short" });
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

  it("answers connect_failed while hc cannot be started, and starts it for the next request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
    const socket = adapterAddress(dir);
    let started = false;
    const hc = new HcConnection(() => {
      if (!started) throw new HcError("closed", "hc could not be started");
      return new FakeCore({ "terminal.list": () => ({ terminals: [terminal("t1")], hidden_finished: 0 }), "doc.get": () => ({ value: LAYOUT, version: 1 }) });
    });
    const adapter = await startHerdrCoreAdapter(hc, socket);
    cleanups.push(() => { adapter.stop(); hc.close(); rmSync(dir, { recursive: true, force: true }); });
    // a snapshot asks three calls and hc's hello at once, a ping hello and two calls: all of them
    // fail, and a rejection nobody hears fails this test, as it ends a running server
    const refused = { code: "connect_failed", message: "hc could not be started" };
    await expect(sessionSnapshot(socket)).rejects.toMatchObject(refused);
    await expect(ping(socket)).rejects.toMatchObject(refused);
    started = true;
    expect((await sessionSnapshot(socket)).panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
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
  async function living(start: HcTerminal[], extra: Record<string, Handler> = {}, pc: Pick<AdapterOptions, "terminalEnv"> = {}) {
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
    }, undefined, undefined, pc);
    return { ...ready, runs, ends };
  }
  const NO_DOC = { "doc.get": () => ({ value: null, version: 0 }) };

  function repository() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ovis-hc-worktree-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, "app");
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main", repo).exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "worktree fixture\n");
    expect(git("-C", repo, "add", "README.md").exitCode).toBe(0);
    expect(git("-C", repo, "commit", "-q", "-m", "fixture").exitCode).toBe(0);
    return { dir, repo, git };
  }
  /**
   * A git before 2.36 (2.34 on Ubuntu 22.04), first on the PATH until the test ends: its
   * `worktree list` has no -z and answers one with its usage, leaving `git.rejected` beside itself
   * each time. `before231`: nor does its `rev-parse` know --path-format, which it writes back as a
   * line of its answer (2.25 on Ubuntu 20.04, 2.30 on Debian 11). Every other call is this PC's git.
   */
  function gitBefore236(dir: string, before231 = false) {
    const real = Bun.which("git")!;
    const bin = join(dir, "git-2.34");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      "list=0",
      'for arg in "$@"; do',
      '  [ "$arg" = list ] && list=1',
      '  if [ "$list" = 1 ] && [ "$arg" = -z ]; then',
      '    : > "$0.rejected"',
      "    printf '%s\\n' \"error: unknown switch \\`z'\" 'usage: git worktree add [<options>] <path> [<commit-ish>]' '   or: git worktree list [<options>]' >&2",
      "    exit 129",
      "  fi",
      "done",
      ...(before231 ? [
        'for arg in "$@"; do',
        '  if [ "$arg" = --path-format=absolute ]; then',
        "    echo --path-format=absolute",
        '    for kept do shift; [ "$kept" = --path-format=absolute ] || set -- "$@" "$kept"; done',
        "    break",
        "  fi",
        "done",
      ] : []),
      `exec '${real}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    cleanups.push(() => {
      if (path === undefined) delete process.env["PATH"];
      else process.env["PATH"] = path;
    });
  }
  /**
   * A git first on the PATH until the test ends whose `rev-parse` answers only once released, as on a
   * network folder or a huge repository: each call reads a fifo whose one writer the test holds open.
   */
  function gitHeld(dir: string): () => void {
    const real = Bun.which("git")!;
    const bin = join(dir, "git-held");
    mkdirSync(bin);
    const hold = join(bin, "hold");
    expect(Bun.spawnSync(["mkfifo", hold]).exitCode).toBe(0);
    const writer = openSync(hold, constants.O_RDWR);
    writeFileSync(join(bin, "git"), [
      "#!/bin/sh",
      `case " $* " in *" rev-parse "*) [ -p '${hold}' ] && cat '${hold}' > /dev/null 2>&1 ;; esac`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    let held = true;
    // the fifo goes first, so no call opens it after the writer closes
    const release = () => {
      if (!held) return;
      held = false;
      rmSync(hold);
      closeSync(writer);
    };
    cleanups.push(() => {
      release();
      if (path === undefined) delete process.env["PATH"];
      else process.env["PATH"] = path;
    });
    return release;
  }
  async function labeling(start: HcTerminal[], extra: Record<string, Handler> = {}) {
    const ready = await living(start, {
      ...NO_DOC,
      "terminal.label": (params) => {
        const found = start.find((entry) => entry.address === params["terminal"])!;
        found.labels = { ...found.labels, ...(params["labels"] as Record<string, string>) };
        return found;
      },
      ...extra,
    });
    return ready;
  }

  it("makes, lists, opens and removes a worktree with git on a core Ovis lays out, grouped under the repository's workspace", async () => {
    const { dir, repo } = repository();
    const { socket } = await labeling([terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } })]);
    expect((await ping(socket)).layout?.worktrees).toBeTrue();

    const listed = await worktreeList("S", socket);
    expect(listed.source).toMatchObject({ repo_root: repo, repo_name: "app", source_checkout_path: repo, source_workspace_id: "S" });
    expect(listed.worktrees).toEqual([expect.objectContaining({ path: repo, branch: "main", is_linked_worktree: false, open_workspace_id: "S" })]);

    const checkout = join(dir, "checkouts", "feature-x");
    const created = await worktreeCreate({ workspaceId: "S", branch: "feature/x", path: checkout }, socket);
    expect(existsSync(join(checkout, "README.md"))).toBeTrue();
    expect(created).toMatchObject({ type: "worktree_created", workspace: { label: "feature-x" }, worktree: { path: checkout, branch: "feature/x", is_linked_worktree: true, open_workspace_id: created.workspace.workspace_id } });
    const facts = (await sessionSnapshot(socket)).workspaces.map((workspace) => [workspace.workspace_id, workspace.worktree?.is_linked_worktree, workspace.worktree?.repo_root]);
    expect(facts).toEqual([["S", false, repo], [created.workspace.workspace_id, true, repo]]);

    const again = await worktreeOpen({ workspaceId: "S", path: checkout }, socket);
    expect(again).toMatchObject({ type: "worktree_opened", already_open: true, workspace: { workspace_id: created.workspace.workspace_id } });
    await expect(workspaceClose("S", socket)).rejects.toMatchObject({ code: "workspace_group_close_required" });

    writeFileSync(join(checkout, "unsaved.txt"), "dirty\n");
    await expect(worktreeRemove(created.workspace.workspace_id, false, socket)).rejects.toMatchObject({ code: "dirty_worktree_requires_force" });
    expect(existsSync(checkout)).toBeTrue();
    expect(await worktreeRemove(created.workspace.workspace_id, true, socket)).toMatchObject({ type: "worktree_removed", path: checkout, forced: true });
    expect(existsSync(checkout)).toBeFalse();
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.workspace_id)).toEqual(["S"]);
  });

  it("keeps to what git and the layout say: nested repositories, moved checkouts, quoted paths and the app's cores", async () => {
    const { dir, git } = repository();
    // a folder git quotes in other listings: its worktree listing names it as it is
    const repo = join(dir, "앱");
    expect(Bun.spawnSync(["mv", join(dir, "app"), repo]).exitCode).toBe(0);
    const nested = join(repo, "nested");
    expect(git("init", "-q", "-b", "main", nested).exitCode).toBe(0);
    const { socket } = await labeling([
      terminal("t1", { cwd: nested, labels: { "herdr.space": "N", "herdr.tab": "T" } }),
      terminal("t2", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "U" } }),
    ]);
    expect((await worktreeList("S", socket)).source).toMatchObject({ repo_root: repo, source_checkout_path: repo, source_workspace_id: "S" });
    const created = await worktreeCreate({ workspaceId: "S", branch: "moved", path: join(dir, "old") }, socket);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => [workspace.workspace_id, workspace.worktree?.repo_root ?? null])).toEqual([["N", nested], ["S", repo], [created.workspace.workspace_id, repo]]);
    // a checkout moved away and another put where it was: neither is deleted for the old workspace
    expect(git("-C", repo, "worktree", "move", join(dir, "old"), join(dir, "new")).exitCode).toBe(0);
    await expect(worktreeRemove(created.workspace.workspace_id, true, socket)).rejects.toMatchObject({ code: "worktree_not_found" });
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "other", join(dir, "old")).exitCode).toBe(0);
    await expect(worktreeRemove(created.workspace.workspace_id, true, socket)).rejects.toMatchObject({ code: "worktree_not_found" });
    expect([existsSync(join(dir, "new", "README.md")), existsSync(join(dir, "old", "README.md"))]).toEqual([true, true]);
    // removed outside Ovis and added again at the same path: git reuses the name of its git folder, not the folder
    const again = await worktreeCreate({ workspaceId: "S", branch: "first", path: join(dir, "again") }, socket);
    expect(git("-C", repo, "worktree", "remove", join(dir, "again")).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "second", join(dir, "again")).exitCode).toBe(0);
    await expect(worktreeRemove(again.workspace.workspace_id, true, socket)).rejects.toMatchObject({ code: "worktree_not_found" });
    expect(existsSync(join(dir, "again", "README.md"))).toBeTrue();
    expect(git("-C", repo, "branch", "kept").exitCode).toBe(0);
    expect(await worktreeCreate({ workspaceId: "S", branch: "kept", base: "main", path: join(dir, "kept") }, socket)).toMatchObject({ worktree: { branch: "kept" } });

    const app = await living([terminal("t1", { cwd: repo })]);
    expect((await ping(app.socket)).layout?.worktrees).toBeFalse();
    await expect(worktreeCreate({ workspaceId: "s1", branch: "app", path: join(dir, "app-wt") }, app.socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(existsSync(join(dir, "app-wt"))).toBeFalse();
  });

  it("refuses a worktree from a linked checkout and a folder outside git, as herdr does", async () => {
    const { dir, repo, git } = repository();
    const linked = join(dir, "linked");
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "linked", linked).exitCode).toBe(0);
    const { socket, runs } = await labeling([
      terminal("t1", { cwd: linked, labels: { "herdr.space": "L", "herdr.tab": "T" } }),
      terminal("t2", { cwd: dir, labels: { "herdr.space": "P", "herdr.tab": "U" } }),
    ]);
    await expect(worktreeCreate({ workspaceId: "L", branch: "other", path: join(dir, "other") }, socket)).rejects.toMatchObject({ code: "linked_worktree_source" });
    expect((await worktreeList("L", socket)).source).toMatchObject({ source_checkout_path: linked, source_workspace_id: null });
    await expect(worktreeList("P", socket)).rejects.toMatchObject({ code: "not_git_worktree" });
    expect(existsSync(join(dir, "other"))).toBeFalse();
    // a repository with no commit yet: git's refusal, which the route turns into repository_without_commits
    expect(git("init", "-q", "-b", "main", join(dir, "empty")).exitCode).toBe(0);
    const empty = await labeling([terminal("t1", { cwd: join(dir, "empty"), labels: { "herdr.space": "E", "herdr.tab": "T" } })]);
    await expect(worktreeCreate({ workspaceId: "E", branch: "first", path: join(dir, "first") }, empty.socket)).rejects.toMatchObject({ code: "worktree_create_failed", message: expect.stringMatching(/invalid reference: HEAD\b/u) });
    expect(existsSync(join(dir, "first"))).toBeFalse();
    expect([...runs, ...empty.runs]).toEqual([]);
  });

  it("nests a checkout no label claims under its repository's workspace by git, on a core Ovis lays out and on one the Herdr app arranges (#3781)", async () => {
    const { dir, repo, git } = repository();
    const linked = join(dir, "checkouts", "feature-x");
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "feature/x", linked).exitCode).toBe(0);
    mkdirSync(join(linked, "src"));
    mkdirSync(join(dir, "plain"));
    const start = () => [
      terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t2", { cwd: join(linked, "src"), labels: { "herdr.space": "W", "herdr.tab": "U" } }),
      terminal("t3", { cwd: join(dir, "plain"), labels: { "herdr.space": "P", "herdr.tab": "V" } }),
      terminal("t4", { cwd: repo, labels: { "herdr.space": "S2", "herdr.tab": "X" } }),
    ];
    const head = { repo_key: realpathSync(join(repo, ".git")), repo_name: "app", repo_root: repo, checkout_path: repo, is_linked_worktree: false };
    for (const core of [await labeling(start()), await living(start())]) {
      const shown = await sessionSnapshot(core.socket);
      const factsOf = (address: string) => shown.workspaces.find((workspace) => workspace.workspace_id === shown.panes.find((pane) => pane.pane_id === address)?.workspace_id)?.worktree ?? null;
      expect([factsOf("t1"), factsOf("t2"), factsOf("t3")]).toEqual([head, { ...head, checkout_path: linked, is_linked_worktree: true }, null]);
      expect(core.runs).toEqual([]);
    }
    // what the sidebar draws is what its actions do, as on herdr: the repository's workspace closes over the
    // repository's other workspaces as a group, the checkout's and the other one on the main checkout
    const grouped = await labeling(start());
    await expect(workspaceClose("S", grouped.socket)).rejects.toMatchObject({ code: "workspace_group_close_required" });
    await workspaceClose("S", grouped.socket, true);
    expect(grouped.ends).toEqual(["kill t1", "kill t2", "kill t4", "rm t1", "rm t2", "rm t4"]);
    const opening = start();
    await worktreeCreate({ workspaceId: "S", branch: "next", path: join(dir, "next") }, (await labeling(opening)).socket);
    expect(JSON.parse(opening[0]!.labels!["ovis.worktree"]!)).toMatchObject({ checkout_path: repo, is_linked_worktree: false, git_id: expect.any(String) });
    // a checkout added again at the same path since git was asked is not the one drawn: it stays
    const replacing = await labeling(start());
    await sessionSnapshot(replacing.socket);
    expect(git("-C", repo, "worktree", "remove", linked).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "feature/y", linked).exitCode).toBe(0);
    mkdirSync(join(linked, "src"));
    await expect(worktreeRemove("W", true, replacing.socket)).rejects.toMatchObject({ code: "worktree_not_found" });
    expect(existsSync(linked)).toBeTrue();
    const moving = start();
    const removing = await labeling(moving);
    await sessionSnapshot(removing.socket);
    moving[1]!.foreground = { pid: 12, name: "bash", cwd: repo };
    expect((await sessionSnapshot(removing.socket)).workspaces.find((workspace) => workspace.workspace_id === "W")?.worktree).toMatchObject({ checkout_path: linked, is_linked_worktree: true });
    expect(await worktreeRemove("W", false, removing.socket)).toMatchObject({ type: "worktree_removed", path: linked, forced: false });
    expect(existsSync(linked)).toBeFalse();
    expect(removing.ends).toEqual(["kill t2", "rm t2"]);
  });

  it("keeps a workspace's checkout through a restart of Ovis: git is asked where its first terminal started, not where its shell went (#3890)", async () => {
    const { dir, repo, git } = repository();
    const linked = join(dir, "checkouts", "feature-x");
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "feature/x", linked).exitCode).toBe(0);
    // a server that first sees the repository's workspace after its shell went into the checkout: a restart, an update
    const { socket, ends } = await labeling([
      terminal("t1", { cwd: repo, foreground: { pid: 11, name: "bash", cwd: linked }, labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t2", { cwd: linked, labels: { "herdr.space": "W", "herdr.tab": "U" } }),
    ]);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => [workspace.workspace_id, workspace.worktree?.checkout_path, workspace.worktree?.is_linked_worktree])).toEqual([["S", repo, false], ["W", linked, true]]);
    await expect(worktreeRemove("S", true, socket)).rejects.toMatchObject({ code: "not_linked_worktree" });
    expect(existsSync(linked)).toBeTrue();
    expect(ends).toEqual([]);
  });

  it("deletes no checkout another workspace is open on (#3890)", async () => {
    const { dir, repo, git } = repository();
    const linked = join(dir, "linked");
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "linked", linked).exitCode).toBe(0);
    const { socket, ends } = await labeling([
      terminal("t1", { cwd: linked, labels: { "herdr.space": "A", "herdr.tab": "T" } }),
      terminal("t2", { cwd: linked, labels: { "herdr.space": "B", "herdr.tab": "U", "ovis.workspace": "reviewer" } }),
    ]);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.worktree?.checkout_path)).toEqual([linked, linked]);
    await expect(worktreeRemove("A", true, socket)).rejects.toMatchObject({ code: "worktree_in_use", message: expect.stringContaining("reviewer") });
    expect(existsSync(join(linked, "README.md"))).toBeTrue();
    expect(ends).toEqual([]);
    // nor one where another workspace, drawn elsewhere, has a terminal that went into it
    mkdirSync(join(dir, "plain"));
    const elsewhere = await labeling([
      terminal("t1", { cwd: linked, labels: { "herdr.space": "A", "herdr.tab": "T" } }),
      terminal("t2", { cwd: join(dir, "plain"), labels: { "herdr.space": "P", "herdr.tab": "U", "ovis.workspace": "notes" } }),
      terminal("t3", { cwd: join(dir, "plain"), foreground: { pid: 13, name: "bash", cwd: join(linked, "src") }, labels: { "herdr.space": "P", "herdr.tab": "U" } }),
    ]);
    expect((await sessionSnapshot(elsewhere.socket)).workspaces.map((workspace) => workspace.worktree?.checkout_path ?? null)).toEqual([linked, null]);
    await expect(worktreeRemove("A", true, elsewhere.socket)).rejects.toMatchObject({ code: "worktree_in_use", message: expect.stringContaining("notes") });
    expect(existsSync(join(linked, "README.md"))).toBeTrue();
    expect(elsewhere.ends).toEqual([]);
    // nor one with a terminal that started there through a link to it
    symlinkSync(linked, join(dir, "alias"));
    const linkedTo = await labeling([
      terminal("t1", { cwd: linked, labels: { "herdr.space": "A", "herdr.tab": "T" } }),
      terminal("t2", { cwd: join(dir, "plain"), labels: { "herdr.space": "P", "herdr.tab": "U", "ovis.workspace": "aliased" } }),
      terminal("t3", { cwd: join(dir, "alias", "src"), labels: { "herdr.space": "P", "herdr.tab": "V" } }),
    ]);
    mkdirSync(join(linked, "src"));
    await expect(worktreeRemove("A", true, linkedTo.socket)).rejects.toMatchObject({ code: "worktree_in_use", message: expect.stringContaining("aliased") });
    expect(existsSync(join(linked, "README.md"))).toBeTrue();
  });

  it("keeps a workspace's checkout while a tab of it started there, whichever tab is in front, and claims no checkout by where a shell went (#3890)", async () => {
    const { dir, repo, git } = repository();
    const [a, b] = [join(dir, "a"), join(dir, "b")];
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "a", a).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "b", b).exitCode).toBe(0);
    mkdirSync(join(dir, "plain"));
    const terminals = [
      terminal("t1", { cwd: a, labels: { "herdr.space": "S", "herdr.tab": "T1" } }),
      terminal("t2", { cwd: b, labels: { "herdr.space": "S", "herdr.tab": "T2" } }),
      terminal("t3", { cwd: repo, labels: { "herdr.space": "R", "herdr.tab": "U" } }),
      terminal("t4", { cwd: join(dir, "plain"), foreground: { pid: 14, name: "bash", cwd: b }, labels: { "herdr.space": "P", "herdr.tab": "V" } }),
    ];
    // Ovis's layout document, which a tab move writes
    let kept: { value: unknown; version: number } = { value: null, version: 0 };
    const { socket } = await labeling(terminals, {
      "doc.get": (params) => params["name"] === "ovis-layout" ? kept : { value: null, version: 0 },
      "doc.set": (params) => { kept = { value: params["value"], version: kept.version + 1 }; return { version: kept.version }; },
    });
    const checkoutOf = async (id: string) => (await sessionSnapshot(socket)).workspaces.find((workspace) => workspace.workspace_id === id)?.worktree?.checkout_path;
    expect(await checkoutOf("S")).toBe(a);
    // another client moves b's tab in front while a confirmation names a
    await tabMove("T2", 0, socket);
    const shown = await sessionSnapshot(socket);
    expect(shown.panes.find((pane) => pane.workspace_id === "S")?.pane_id).toBe("t2");
    expect(await checkoutOf("S")).toBe(a);
    // a shell that went into b from outside git does not make its workspace b's
    expect((await worktreeOpen({ workspaceId: "R", path: b }, socket)).already_open).toBeFalse();
    expect(await worktreeRemove("S", true, socket)).toMatchObject({ type: "worktree_removed", path: a });
    expect([existsSync(a), existsSync(join(b, "README.md"))]).toEqual([false, true]);
  });

  it("keeps the checkout a row was first drawn with from a cached answer while git is asked again (#3890)", async () => {
    const { dir, repo, git } = repository();
    const [a, b] = [join(dir, "a"), join(dir, "b")];
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "a", a).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "b", b).exitCode).toBe(0);
    const terminals = [terminal("t1", { cwd: a, labels: { "herdr.space": "X", "herdr.tab": "T0" } })];
    const find = (params: Record<string, unknown>) => terminals.find((entry) => entry.address === params["terminal"]) ?? (() => { throw new Error("no terminal"); })();
    let kept: { value: unknown; version: number } = { value: null, version: 0 };
    // the core's terminals as this test changes them
    const { socket } = await labeling(terminals, {
      "terminal.list": () => ({ terminals, hidden_finished: 0 }),
      "terminal.get": find,
      "terminal.kill": (params) => Object.assign(find(params), { state: "finished" }),
      "terminal.rm": (params) => { terminals.splice(terminals.indexOf(find(params)), 1); return { removed: params["terminal"] }; },
      "doc.get": (params) => params["name"] === "ovis-layout" ? kept : { value: null, version: 0 },
      "doc.set": (params) => { kept = { value: params["value"], version: kept.version + 1 }; return { version: kept.version }; },
    });
    // git answered for a's folder once, for another workspace
    expect((await sessionSnapshot(socket)).workspaces[0]?.worktree?.checkout_path).toBe(a);
    terminals.splice(0, 1,
      terminal("t2", { cwd: a, labels: { "herdr.space": "S", "herdr.tab": "T1" } }),
      terminal("t3", { cwd: b, labels: { "herdr.space": "S", "herdr.tab": "T2" } }));
    // past the time that answer is kept, and git slow to answer again: the row is drawn from the cached answer
    setSystemTime(new Date(Date.now() + 60_000));
    cleanups.push(() => setSystemTime());
    const release = gitHeld(dir);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.worktree?.checkout_path)).toEqual([a]);
    await tabMove("T2", 0, socket);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.worktree?.checkout_path)).toEqual([a]);
    release();
    expect(await worktreeRemove("S", true, socket)).toMatchObject({ type: "worktree_removed", path: a });
    expect(existsSync(join(b, "README.md"))).toBeTrue();
  }, 15_000);

  it("deletes no checkout added again at the path after git was asked again (#3890)", async () => {
    const { dir, repo, git } = repository();
    const linked = join(dir, "linked");
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "first", linked).exitCode).toBe(0);
    const { socket, cores } = await labeling([
      terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t2", { cwd: linked, labels: { "herdr.space": "W", "herdr.tab": "U" } }),
    ], { "events.subscribe": () => ({ channel: cores.at(-1)!.channel(), seq: 1, terminals: [] }) });
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.worktree?.checkout_path)).toEqual([repo, linked]);
    expect(git("-C", repo, "worktree", "remove", linked).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "-b", "second", linked).exitCode).toBe(0);
    const started = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "layout.updated" }], { onEvent: (frame) => { if (frame.event === "layout.updated") asked.resolve(); }, onStarted: () => started.resolve(), onClose() {} }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    // past the time git's facts are kept: the next snapshot asks git again, and its new answer is told
    setSystemTime(new Date(Date.now() + 60_000));
    cleanups.push(() => setSystemTime());
    await sessionSnapshot(socket);
    await asked.promise;
    await expect(worktreeRemove("W", true, socket)).rejects.toMatchObject({ code: "worktree_not_found" });
    expect(existsSync(join(linked, "README.md"))).toBeTrue();
  });

  it("waits on a slow git once per folder, and asks for a fresh snapshot when it answers (#3890)", async () => {
    const { dir, repo } = repository();
    const release = gitHeld(dir);
    const { socket, cores } = await living([terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } })], {
      ...NO_DOC,
      "events.subscribe": () => ({ channel: cores.at(-1)!.channel(), seq: 1, terminals: [] }),
    });
    const facts = async () => (await sessionSnapshot(socket)).workspaces[0]?.worktree ?? null;
    expect(await facts()).toBeNull();
    // waited out once: the row is drawn flat at once while git has still not answered
    for (const _ of [1, 2]) {
      const began = performance.now();
      expect(await facts()).toBeNull();
      expect(performance.now() - began).toBeLessThan(1_000);
    }
    const started = Promise.withResolvers<void>();
    const updated = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "layout.updated" }], { onEvent: (frame) => { if (frame.event === "layout.updated") updated.resolve(); }, onStarted: () => started.resolve(), onClose() {} }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    release();
    await updated.promise;
    expect(await facts()).toMatchObject({ checkout_path: repo, is_linked_worktree: false });
  }, 15_000);

  it("lists, makes and removes a worktree with a git before 2.36, whose worktree list has no -z", async () => {
    const { dir, git } = repository();
    // quotes and letters outside ASCII, which git escapes in other listings: this one names them as they are, by line too
    const repo = join(dir, '앱 "old" git');
    expect(Bun.spawnSync(["mv", join(dir, "app"), repo]).exitCode).toBe(0);
    expect(git("-C", repo, "worktree", "add", "-q", "--detach", join(dir, "detached")).exitCode).toBe(0);
    gitBefore236(dir);
    const { socket } = await labeling([terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } })]);

    const listed = await worktreeList("S", socket);
    // the stand-in was the git asked, with -z first: a git that has it is never listed by line
    expect(existsSync(join(dir, "git-2.34", "git.rejected"))).toBeTrue();
    expect(listed.source).toMatchObject({ repo_root: repo, repo_name: '앱 "old" git', source_checkout_path: repo, source_workspace_id: "S" });
    expect(listed.worktrees).toEqual([
      expect.objectContaining({ path: repo, branch: "main", is_detached: false, is_linked_worktree: false, open_workspace_id: "S" }),
      expect.objectContaining({ path: join(dir, "detached"), branch: null, is_detached: true, is_linked_worktree: true, open_workspace_id: null }),
    ]);

    const checkout = join(dir, "made here");
    const created = await worktreeCreate({ workspaceId: "S", branch: "feature/x", path: checkout }, socket);
    expect(created).toMatchObject({ type: "worktree_created", worktree: { path: checkout, branch: "feature/x", is_linked_worktree: true } });
    expect((await worktreeList("S", socket)).worktrees.map((worktree) => [worktree.path, worktree.open_workspace_id])).toEqual([[repo, "S"], [join(dir, "detached"), null], [checkout, created.workspace.workspace_id]]);
    expect(await worktreeRemove(created.workspace.workspace_id, false, socket)).toMatchObject({ type: "worktree_removed", path: checkout });
    expect(existsSync(checkout)).toBeFalse();
  });

  it("refuses the listing of a git before 2.31, whose rev-parse answers are one line off", async () => {
    const { dir, repo } = repository();
    gitBefore236(dir, true);
    const { socket } = await labeling([terminal("t1", { cwd: repo, labels: { "herdr.space": "S", "herdr.tab": "T" } })]);
    await expect(worktreeList("S", socket)).rejects.toMatchObject({ code: "worktree_list_failed", message: expect.stringContaining("older than 2.31") });
  });

  it("reads git's line listing of checkouts as its -z one, each path as it is", () => {
    const head = "HEAD 451973cecfbf57f3872e98c4314dffb0395fe352";
    const blocks = [
      ["worktree /srv/app.git", "bare"],
      ['worktree /home/u/앱 "old" git', head, "branch refs/heads/feature/x"],
      ["worktree /home/u/detached", head, "detached", "locked"],
      ["worktree /home/u/gone", head, "branch refs/heads/gone", "prunable gitdir file points to non-existent location"],
    ];
    const listing = (end: string) => blocks.map((block) => `${block.join(end)}${end}${end}`).join("");
    const checkouts = [
      { path: "/srv/app.git", branch: null, is_bare: true, is_detached: false, is_prunable: false },
      { path: '/home/u/앱 "old" git', branch: "feature/x", is_bare: false, is_detached: false, is_prunable: false },
      { path: "/home/u/detached", branch: null, is_bare: false, is_detached: true, is_prunable: false },
      { path: "/home/u/gone", branch: "gone", is_bare: false, is_detached: false, is_prunable: true },
    ];
    expect(parseCheckouts(listing("\0"))).toEqual(checkouts);
    expect(parseCheckouts(listing("\n"), "\n")).toEqual(checkouts);
  });

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

  it("splits no pane on a core that keeps no documents", async () => {
    const { socket, runs } = await living([terminal("t1", { labels: { "herdr.space": "S", "herdr.tab": "T" } })], NO_DOC);
    await expect(herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(runs).toEqual([]);
  });

  it("starts each shell in the user's terminal environment, under what the call asks for", async () => {
    const terminalEnv = { NO_COLOR: "", GH_TOKEN: "from-profile", TERM: "xterm-256color" };
    const { socket, runs } = await living([terminal("t1")], {}, { terminalEnv: async () => terminalEnv });
    await workspaceCreate({ cwd: "/work/web", label: "web" }, socket);
    await herdrRpc("workspace.create", { cwd: "/work/api", env: { GH_TOKEN: "asked" } }, socket);
    expect(runs.map((run) => run["env"])).toEqual([terminalEnv, { ...terminalEnv, GH_TOKEN: "asked" }]);
  });

  it("sends hc no env at all when there is none to give, as on Windows", async () => {
    const { socket, runs } = await living([terminal("t1")], {}, { terminalEnv: async () => ({}) });
    await workspaceCreate({ cwd: "/work/web", label: "web" }, socket);
    expect(runs[0]).not.toHaveProperty("env");
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

  it("closes a tab's terminal the Herdr app holds hidden along with the rest", async () => {
    const layout = { spaces: [{ id: "s1", name: "api", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [
      { type: "block", id: "b1", content: { terminal: "t1" } }, { type: "block", id: "b3", hidden: true, content: { terminal: "t3" } },
    ] } }] }] };
    const { socket, ends } = await living([terminal("t1"), terminal("t3")], { "doc.get": (params) => ({ value: params["name"] === "herdr-app" ? layout : null, version: 1 }) });
    await tabClose("s1t1", socket);
    expect(ends.sort()).toEqual(["kill t1", "kill t3", "rm t1", "rm t3"]);
  });

  it("closes only a tab's own terminal when labels name the same ids in other spaces", async () => {
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
  /** A core whose panes run POSIX shells, whatever this PC is: what runs in them is hc's to say, never a process table's. */
  const posix = (terminals: HcTerminal[], extra: Record<string, Handler> = {}, platform: NodeJS.Platform = "linux") => setup(terminals, extra, undefined, undefined, { platform, processTable: () => { throw new Error("no process table off Windows"); } });

  it("starts an agent by typing its kind and quoted arguments into the pane's idle shell, and answers once it is in front", async () => {
    const shell = { pid: 10, name: "bash" };
    const agent = { pid: 11, name: "claude" };
    const record = terminal("t1", { cols: 90, rows: 20, pid: 10, argv: ["/bin/bash"], foreground: shell });
    const { socket, cores } = await posix([record], {
      "terminal.get": () => ({ ...record, foreground: cores[0]!.typed.length > 0 ? agent : shell }),
    });
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--model", "it's big"] }, socket);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toMatchObject({ terminal: "t1", cols: 90, rows: 20 });
    expect(core.typed.map((write) => write.text).join("")).toBe("\u0015'claude' '--model' 'it'\\''s big'\r");
    const methods = core.calls.map((call) => call.method);
    expect(methods.lastIndexOf("terminal.get")).toBeGreaterThan(methods.indexOf("terminal.attach"));
  });

  it("counts an agent run through its interpreter as started, and a shell's command-not-found handler as a failed start", async () => {
    const shell = { pid: 10, name: "bash" };
    const sequence = (after: { pid: number; name: string; argv?: string[] }[]) => {
      const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
      const holder: { cores: FakeCore[] } = { cores: [] };
      let seen = 0;
      const get = () => ({ ...record, foreground: holder.cores[0]?.typed.length ? after[Math.min(seen++, after.length - 1)] : shell });
      return { record, holder, get };
    };
    const node = sequence([{ pid: 11, name: "node", argv: ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"] }]);
    const started = await posix([node.record], { "terminal.get": node.get });
    node.holder.cores = started.cores;
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, started.socket);
    const missing = sequence([{ pid: 12, name: "python3", argv: ["/usr/bin/python3", "/usr/lib/command-not-found", "--", "amp"] }, shell]);
    const failed = await posix([missing.record], { "terminal.get": missing.get });
    missing.holder.cores = failed.cores;
    await expect(agentStart({ name: "amp-1", kind: "amp", paneId: "t1" }, failed.socket)).rejects.toMatchObject({ code: "agent_start_failed" });
  });

  it("lets what is typed after a start reach the pane while the start waits for its agent", async () => {
    const shell = { pid: 10, name: "bash" };
    const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
    const holder: { cores: FakeCore[]; agentUp: boolean } = { cores: [], agentUp: false };
    const ready = await posix([record], { "terminal.get": () => ({ ...record, foreground: holder.agentUp ? { pid: 11, name: "claude" } : shell }) });
    holder.cores = ready.cores;
    const starting = agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, ready.socket);
    let started = false;
    void starting.then(() => { started = true; });
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
    const ready = await posix([record], { "terminal.get": () => ({ ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "cursor-agent" } : shell }) });
    holder.cores = ready.cores;
    await agentStart({ name: "cursor-1", kind: "cursor", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'cursor-agent'\r");
  });

  it("refuses a pane with a program in front, a kind that is no command, and an argument with a control character", async () => {
    const { socket, cores } = await posix([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 12, name: "vim" } })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "x", kind: "rm -rf /", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", args: ["a\u0015touch /tmp/x\r"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t9" }, socket)).rejects.toMatchObject({ code: "pane_not_found" });
    expect(cores[0]!.typed).toEqual([]);
  });

  // hc 0.1.21 runs a template's `command:` as `sh -c "<line>"`: dash stays in front and the agent is its child (#4052)
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("names the program a template's shell runs below it, and nothing below any other program in front", async () => {
    const line = "cat; true";
    const shell = Bun.spawn(["sh", "-c", line], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    try {
      // cat echoing a line proves the shell's child has become cat: a forked child not yet exec'd is still named sh
      shell.stdin.write("started\n");
      await shell.stdin.flush();
      const output = shell.stdout.getReader();
      let echoed = "";
      while (!echoed.includes("started\n")) {
        const { done, value } = await output.read();
        if (done) throw new Error(`the template's shell ended before its child echoed, after ${JSON.stringify(echoed)}`);
        echoed += new TextDecoder().decode(value);
      }
      const { socket } = await posix([
        terminal("t1", { pid: shell.pid, argv: ["sh", "-c", line], foreground: { pid: shell.pid, name: "sh", argv: ["sh", "-c", line] } }),
        terminal("t2", { pid: shell.pid, argv: ["agent"], foreground: { pid: shell.pid, name: "agent", argv: ["agent"] } }),
      ]);
      const info = await paneProcessInfo("t1", socket);
      expect(info?.foreground_processes?.map(({ name, argv }) => [name, argv])).toEqual([["sh", ["sh", "-c", line]], ["cat", ["cat"]]]);
      expect((await paneProcessInfo("t2", socket))?.foreground_processes?.map(({ name }) => name)).toEqual(["agent"]);
    } finally { shell.kill("SIGKILL"); }
  });

  it("types into no pane whose own program is not a shell, even with that program in front of itself", async () => {
    // a terminal the app started as a program: hc reports it in front of itself, like a shell
    const { socket, cores } = await posix([
      terminal("t1", { pid: 10, argv: ["claude"], foreground: { pid: 10, name: "claude", argv: ["claude"] } }),
      // a template or a line: dash runs it as its child and stays in front under its own pid
      terminal("t2", { pid: 20, argv: ["sh", "-c", "claude"], foreground: { pid: 20, name: "sh", argv: ["sh", "-c", "claude"] } }),
    ]);
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    await expect(agentStart({ name: "y", kind: "codex", paneId: "t2" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("types into no shell that exec'd a non-plain shell, and checks fish's quoting on the shell in front", async () => {
    const { socket, cores } = await posix([
      terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "bash", argv: ["bash", "-c", "read line"] } }),
      terminal("t2", { pid: 20, argv: ["/bin/bash"], foreground: { pid: 20, name: "fish", argv: ["fish"] } }),
    ]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", timeoutMs: 300 }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "y", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("refuses a backslash fish would read differently", async () => {
    const fish = { pid: 20, name: "fish", argv: ["/usr/bin/fish"] };
    const { socket, cores } = await posix([terminal("t2", { pid: 20, argv: ["/usr/bin/fish"], foreground: fish })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("starts in a login shell", async () => {
    const login = { pid: 10, name: "zsh", argv: ["-zsh", "-l"] };
    const record = terminal("t1", { pid: 10, argv: ["-zsh", "-l"], foreground: login });
    const holder: { cores: FakeCore[] } = { cores: [] };
    const ready = await posix([record], { "terminal.get": () => ({ ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "claude" } : login }) });
    holder.cores = ready.cores;
    await agentStart({ name: "y", kind: "claude", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'claude'\r");
  });

  it("takes a program for a shell by its exact name off Windows: in another case, as an .exe or after a backslash it is none", async () => {
    const panes = [["/bin/BASH", "agent_pane_unsupported"], ["Zsh", "agent_pane_unsupported"], ["bash.exe", "agent_pane_unsupported"], ["/opt/odd\\bash", "agent_pane_unsupported"], ["/usr/bin/pwsh", "agent_pane_unsupported"], ["cmd.exe", "agent_pane_unsupported"], ["/bin/bash", "agent_pane_busy"], ["-zsh", "agent_pane_busy"]] as const;
    for (const platform of ["linux", "darwin"] as const) {
      for (const [program, code] of panes) {
        const { socket, cores } = await posix([terminal("t1", { pid: 10, argv: [program], foreground: { pid: 12, name: "vim" } })], {}, platform);
        await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code });
        expect(cores[0]!.typed).toEqual([]);
      }
    }
  });

  it("reads a program's path at a / alone and in its own case off Windows, and types the same line on macOS", async () => {
    for (const [name, started] of [["/opt/claude/run", true], ["/opt/Claude/run", false], ["C:\\tools\\claude.exe", false]] as const) {
      const shell = { pid: 10, name: "bash" };
      const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
      const holder: { cores: FakeCore[]; looks: number } = { cores: [], looks: 0 };
      const ready = await posix([record], { "terminal.get": () => ({ ...record, foreground: !holder.cores[0]?.typed.length ? shell : holder.looks++ === 0 ? { pid: 11, name } : shell }) }, "darwin");
      holder.cores = ready.cores;
      const start = agentStart({ name: "x", kind: "claude", paneId: "t1" }, ready.socket);
      if (started) await start;
      else await expect(start).rejects.toMatchObject({ code: "agent_start_failed" });
      expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'claude'\r");
    }
  });

  it("types into no shell that has become another program with exec, its pid unchanged", async () => {
    const { socket, cores } = await posix([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "claude", argv: ["claude"] } })]);
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("offers the agents Ovis knows by kind, leaving the ones Ovis starts itself to the server", async () => {
    const { socket } = await setup([terminal("t1")]);
    const kinds = (await agentManifests(socket)).manifests.map((manifest) => manifest.agent);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
    expect(kinds).not.toContain("omo");
    expect(kinds).toContain("cmd");
  });
});

describe("herdr-core adapter, agents on Windows", () => {
  const POWERSHELL = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  // what hc runs for a terminal started with no program (a live record, hc 0.1.17; its hook cut short)
  const HC_SHELL = ["powershell.exe", "-NoExit", "-Command", "$global:__hc_prompt = $function:prompt; function global:prompt { $p = & $global:__hc_prompt; $p }"];
  const row = (pid: number, parent: number, path: string, commandLine = `"${path}"`): ProcessRow => ({ pid, parent, path, commandLine });
  // the pane's shell, and the console hosts below it, which are no program it runs
  const idle = [row(10, 9, POWERSHELL, `"${POWERSHELL}" -NoExit -Command x`), row(12, 10, "C:\\WINDOWS\\system32\\conhost.exe", "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0xffffffff -ForceV1"), row(15, 10, "C:\\Users\\u\\conpty\\OpenConsole.exe")];
  // named as its file is: Windows takes a program's name in any case
  const claude = row(11, 10, "C:\\Users\\u\\.local\\bin\\Claude.exe", "\"C:\\Users\\u\\.local\\bin\\Claude.exe\" --model x");

  /**
   * A pane whose own program is `argv`, at `path`, which hc names in front of itself whatever runs
   * in it, as it does on Windows; this PC's process table is `table` for what was typed so far.
   */
  async function windows(argv: string[], table: (typed: string) => ProcessRow[] | Promise<ProcessRow[]>, path = POWERSHELL) {
    let cores: FakeCore[] = [];
    const typed = () => cores[0]?.typed.map((write) => write.text).join("") ?? "";
    const front = { pid: 10, name: path.split("\\").pop()!, argv: [path, ...argv.slice(1)] };
    const ready = await setup([terminal("t1", { cwd: "C:\\work", pid: 10, argv, foreground: front })], {}, undefined, undefined, { platform: "win32", processTable: async () => await table(typed()) });
    cores = ready.cores;
    return { ...ready, typed };
  }

  it("offers the agents Ovis knows by kind, leaving the ones Ovis starts itself to the server", async () => {
    const { socket, typed } = await windows(HC_SHELL, () => idle);
    const kinds = (await agentManifests(socket)).manifests.map((manifest) => manifest.agent);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
    expect(kinds).not.toContain("omo");
    // Command Code's command `cmd` is cmd.exe here: not offered, and not started when asked
    expect(kinds).not.toContain("cmd");
    await expect(agentStart({ name: "x", kind: "cmd", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(typed()).toBe("");
  });

  it("starts an agent in hc's own PowerShell by typing a call, and answers once it runs below the shell", async () => {
    const { socket, typed } = await windows(HC_SHELL, (line) => line ? [...idle, claude] : idle);
    // one Windows PowerShell 5.1 would split is refused, and nothing is typed for it
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", args: ['"fix the bug"'] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    // and one cmd would run part of, were the agent a .cmd file
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1", args: ['fix "a&echo ran&b" now'] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(typed()).toBe("");
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--model", "say \"hi\"", ""] }, socket);
    // no Ctrl-U, which PowerShell would type into the line; the quote and the empty argument go as
    // Windows PowerShell must give them for the agent to read them back
    expect(typed()).toBe(`& 'claude' '--model' 'say \\"hi\\"' '""'\r`);
  });

  it("starts Claude Code with Ultracode's settings file from a profile folder holding & (#3084)", async () => {
    const { socket, typed } = await windows(HC_SHELL, (line) => line ? [...idle, claude] : idle);
    const settings = "C:\\Users\\R&D\\AppData\\Local\\ovis\\claude settings\\a.json";
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--settings", settings] }, socket);
    expect(typed()).toBe(`& 'claude' '--settings' '${settings}'\r`);
  });

  it("types into no pane whose own program runs a program: the app's own, a script, cmd /c, and no cmd that expands !", async () => {
    for (const argv of [["powershell.exe", "-NoExit", "-Command", "& 'claude'"], ["powershell.exe", "-File", "start.ps1"], ["cmd.exe", "/d", "/c", "claude"], ["cmd.exe", "/q/k", "claude"], ["CMD.EXE", "/R", "x"], ["cmd.exe", "/V:ON"], ["claude.exe"]]) {
      const { socket, typed } = await windows(argv, () => idle);
      await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
      expect(typed()).toBe("");
    }
  });

  it("types into no POSIX shell on Windows: Git Bash's MSYS would rewrite an argument, and WSL's agent is in no Windows table", async () => {
    for (const path of ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "C:\\WINDOWS\\system32\\bash.exe"]) {
      const { socket, typed } = await windows([path, "--login", "-i"], () => idle, path);
      await expect(agentStart({ name: "x", kind: "codex", paneId: "t1", args: ["/review the diff"] }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
      expect(typed()).toBe("");
    }
  });

  it("waits while the shell runs a program below it, while the table cannot be read, and until hc names the shell in front", async () => {
    for (const table of [[...idle, row(13, 10, "C:\\Program Files\\Git\\cmd\\git.exe", "git fetch")], []]) {
      const { socket, typed } = await windows(HC_SHELL, () => table);
      await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
      expect(typed()).toBe("");
    }
    const { socket, cores } = await setup([terminal("t1", { pid: 10, argv: HC_SHELL })], {}, undefined, undefined, { platform: "win32", processTable: async () => idle });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("counts an agent run through node as started, and a program that ends without it as a failed start", async () => {
    const node = row(13, 10, "C:\\Program Files\\nodejs\\node.exe", "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
    const started = await windows(HC_SHELL, (line) => line ? [...idle, node] : idle);
    await agentStart({ name: "codex-1", kind: "codex", paneId: "t1" }, started.socket);
    // npm's .ps1 shim names the script with forward slashes
    const shimmed = row(13, 10, "C:\\Program Files\\nodejs\\node.exe", "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\u\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js");
    const throughShim = await windows(HC_SHELL, (line) => line ? [...idle, shimmed] : idle);
    await agentStart({ name: "codex-1", kind: "codex", paneId: "t1" }, throughShim.socket);
    // an npm shim runs below the shell, and ends with no agent come up
    const shim = row(14, 10, "C:\\WINDOWS\\system32\\cmd.exe", "C:\\WINDOWS\\system32\\cmd.exe /c \"C:\\Users\\u\\AppData\\Roaming\\npm\\amp.cmd\"");
    let looks = 0;
    const failed = await windows(HC_SHELL, (line) => line ? [[...idle, shim], [], idle][Math.min(looks++, 2)]! : idle);
    await expect(agentStart({ name: "amp-1", kind: "amp", paneId: "t1" }, failed.socket)).rejects.toMatchObject({ code: "agent_start_failed" });
    expect(looks).toBe(3);
  });

  it("types cmd's line and PowerShell 7's, and refuses an argument cmd or PowerShell 7 would not pass unchanged", async () => {
    const shells = [
      // the name unquoted: a .cmd shim found on the PATH under a quoted name reads the current folder as its own
      { argv: ["cmd.exe"], path: "C:\\WINDOWS\\system32\\cmd.exe", refused: "%PATH%", line: 'claude "--model" "a b"\r' },
      { argv: ["pwsh.exe", "-NoLogo"], path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", refused: "say \"hi\"", line: "& 'claude' '--model' 'a b'\r" },
      { argv: ["pwsh.exe", ...HC_SHELL.slice(1)], path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", refused: "", line: "& 'claude' '--model' 'a b'\r" },
      // Windows takes a name and a switch in any case
      { argv: [POWERSHELL.toUpperCase(), "-nologo", "-NOEXIT"], path: POWERSHELL, refused: '"fix the bug"', line: "& 'claude' '--model' 'a b'\r" },
    ];
    for (const shell of shells) {
      const { socket, typed } = await windows(shell.argv, (line) => line ? [...idle, claude] : idle, shell.path);
      await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", args: [shell.refused] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
      expect(typed()).toBe("");
      await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--model", "a b"] }, socket);
      expect(typed()).toBe(shell.line);
    }
  });

  it("holds what is typed behind the start line while it reads the table, and not while the start waits for its agent", async () => {
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    let up = false;
    const { socket, typed } = await windows(HC_SHELL, async (line) => {
      if (line) return up ? [...idle, claude] : idle;
      reading.resolve();
      await read.promise;
      return idle;
    });
    const starting = agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, socket);
    let started = false;
    void starting.then(() => { started = true; });
    await reading.promise;
    const early = paneSendText("t1", "early", socket);
    read.resolve();
    await early;
    expect(typed()).toBe("& 'claude'\rearly");
    await paneSendText("t1", "late", socket);
    expect(typed()).toBe("& 'claude'\rearlylate");
    expect(started).toBe(false);
    up = true;
    await starting;
  });

  it("offers and starts no agent on another machine: this PC's table says nothing of its shell, whichever it runs", async () => {
    let reads = 0;
    for (const [argv, name] of [[HC_SHELL, "powershell.exe"], [["/bin/bash"], "bash"]] as const) {
      const { socket, cores } = await setup([terminal("lab/t1", { pid: 41, argv: [...argv], foreground: { pid: 41, name } })], {}, undefined, "lab", { platform: "win32", processTable: async () => { reads += 1; return idle; } });
      expect((await agentManifests(socket)).manifests).toEqual([]);
      await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
      await expect(agentStart({ name: "x", kind: "claude", paneId: "t9" }, socket)).rejects.toMatchObject({ code: "pane_not_found" });
      expect(cores.flatMap((core) => core.typed)).toEqual([]);
    }
    expect(reads).toBe(0);
  });
});
});

describe("herdr-core adapter, Ovis's layout document", () => {
  /** hc's documents: `doc.set` writes only at the version read (`conflict` otherwise), `conflicts` more writers come first */
  function documents(conflicts = 0, otherWriter?: (docs: Map<string, { value: unknown; version: number }>) => void) {
    const docs = new Map<string, { value: unknown; version: number }>();
    const writes: unknown[] = [];
    const conflict = () => Object.assign(new Error("conflict"), { kind: "conflict" });
    let interleave = otherWriter;
    return {
      docs,
      writes,
      handlers: {
        "doc.get": (params: Record<string, unknown>) => docs.get(String(params["name"])) ?? { value: null, version: 0 },
        "doc.set": (params: Record<string, unknown>) => {
          const name = String(params["name"]);
          writes.push(params["value"]);
          if (interleave) { interleave(docs); interleave = undefined; }
          const stored = docs.get(name) ?? { value: null, version: 0 };
          if (conflicts > 0) { conflicts--; docs.set(name, { ...stored, version: stored.version + 1 }); throw conflict(); }
          if (params["version"] !== stored.version) throw conflict();
          docs.set(name, { value: params["value"], version: stored.version + 1 });
          return { version: stored.version + 1 };
        },
      } satisfies Record<string, Handler>,
    };
  }
  async function core(start: HcTerminal[], store = documents()) {
    const terminals = [...start];
    let next = terminals.length + 1;
    const ready = await setup(terminals, {
      ...store.handlers,
      "terminal.run": (params) => {
        const record = terminal(`t${next++}`, { labels: params["labels"] as Record<string, string> });
        terminals.push(record);
        return record;
      },
      // `key: ""` takes a label off, as hc does
      "terminal.label": (params) => {
        const index = terminals.findIndex((entry) => entry.address === params["terminal"]);
        const merged = { ...terminals[index]!.labels, ...(params["labels"] as Record<string, string>) };
        terminals[index] = { ...terminals[index]!, labels: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== "")) };
        return terminals[index];
      },
    });
    return { ...ready, terminals, store };
  }
  const labeled = (address: string, space = "S", tab = "T") => terminal(address, { labels: { "herdr.space": space, "herdr.tab": tab } });
  const rects = async (socket: string) => Object.fromEntries((await sessionSnapshot(socket)).layouts[0]!.panes.map((pane) => [pane.pane_id, pane.rect]));

  it("marks as its own tab exactly the panes it refuses to split: a helper's and Other terminals' (#2806)", async () => {
    const { socket } = await core([labeled("t1"), terminal("t5", { parent: "t1" }), terminal("t6")]);
    const panes = (await sessionSnapshot(socket)).panes as HerdrPane[];
    expect(panes.map((pane) => [pane.pane_id, pane.own_tab])).toEqual([["t1", undefined], ["t5", true], ["t6", true]]);
    for (const pane of panes.filter((candidate) => candidate.own_tab)) {
      await expect(herdrRpc("pane.split", { target_pane_id: pane.pane_id, direction: "right" }, socket)).rejects.toMatchObject({ code: "unsupported" });
    }
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket);
  });

  it("splits right then down as one tree, laid out top down whatever size the viewers make the terminals (#2812)", async () => {
    const { socket, terminals, store } = await core([labeled("t1")]);
    expect((await herdrRpc<{ pane: { pane_id: string; tab_id: string } }>("pane.split", { target_pane_id: "t1", direction: "right" }, socket)).pane).toMatchObject({ pane_id: "t2", tab_id: "T" });
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "down" }, socket);
    const placed = { t1: { x: 0, y: 0, width: 500, height: 500 }, t3: { x: 0, y: 500, width: 500, height: 500 }, t2: { x: 500, y: 0, width: 500, height: 1000 } };
    expect(await rects(socket)).toEqual(placed);
    for (const [index, held] of terminals.entries()) terminals[index] = { ...held, cols: 15 - index, rows: 1 };
    expect(await rects(socket)).toEqual(placed);
    expect(await rects(socket)).toEqual(placed);
    expect(store.docs.get("ovis-layout")!.value).toEqual({ schema: 1, workspaces: [{ id: "S", tabs: [{ id: "T", zoomed: null,
      root: { split: "right", ratio: 0.5, first: { split: "down", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t3" } }, second: { leaf: "t2" } } }] }] });
    const layout = (await sessionSnapshot(socket)).layouts[0]!;
    expect(layout.splits.map((split) => split.id)).toEqual(["split_0_root", "split_1_0"]);
  });

  const splitRun = async (cwd: string, machine?: string): Promise<Record<string, unknown>> => {
    const runs: Record<string, unknown>[] = [];
    const prefix = machine ? `${machine}/` : "";
    const terminals = [terminal(`${prefix}t1`, { cwd, labels: { "herdr.space": "S", "herdr.tab": "T" } })];
    const { socket } = await setup(terminals, {
      ...documents().handlers,
      "terminal.run": (params) => {
        runs.push(params);
        const record = terminal(`${prefix}t2`, { labels: params["labels"] as Record<string, string> });
        terminals.push(record);
        return record;
      },
    }, undefined, machine);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket);
    return runs[0]!;
  };

  it("splits a pane whose folder is there in that folder", async () => {
    expect((await splitRun(tmpdir()))["cwd"]).toBe(tmpdir());
  });

  it("splits a pane whose folder is gone into a shell at this PC's home", async () => {
    expect((await splitRun("/nonexistent/removed-worktree"))["cwd"]).toBe(homedir());
  });

  it("splits a pane on another machine in its folder, which this PC's disk does not hold", async () => {
    expect(await splitRun("/nonexistent/only-on-lab", "lab")).toMatchObject({ on: "lab-id", cwd: "/nonexistent/only-on-lab" });
  });

  it("splits a pane that reports no folder into a shell given none", async () => {
    expect(await splitRun("")).not.toHaveProperty("cwd");
  });

  it("writes again at the new version when another writer came first, once", async () => {
    const store = documents(1);
    const { socket } = await core([labeled("t1")], store);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket);
    expect(store.writes).toHaveLength(2);
    expect(store.docs.get("ovis-layout")!.version).toBe(2);
    expect(Object.keys(await rects(socket))).toEqual(["t1", "t2"]);
  });

  it("moves a divider, resizes, swaps and zooms panes in the document", async () => {
    const { socket } = await core([labeled("t1")]);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket);
    await herdrRpc("layout.set_split_ratio", { tab_id: "T", path: [], ratio: 0.3 }, socket);
    expect((await rects(socket))["t1"]!.width).toBe(300);
    const resized = await herdrRpc<{ resize: { changed: boolean; layout: { panes: { pane_id: string; rect: { width: number } }[] } } }>("pane.resize", { pane_id: "t1", direction: "right", amount: 0.2 }, socket);
    expect(resized.resize.changed).toBe(true);
    expect(resized.resize.layout.panes[0]!.rect.width).toBe(500);
    const swapped = await herdrRpc<{ swap: { changed: boolean; target_pane_id: string } }>("pane.swap", { pane_id: "t1", direction: "right" }, socket);
    expect(swapped.swap).toMatchObject({ changed: true, target_pane_id: "t2" });
    expect((await rects(socket))["t2"]!.x).toBe(0);
    expect((await herdrRpc<{ swap: { changed: boolean; reason: string } }>("pane.swap", { pane_id: "t2", direction: "left" }, socket)).swap).toMatchObject({ changed: false, reason: "no_neighbor" });
    const zoomed = await herdrRpc<{ zoom: { zoomed: boolean; focused_pane_id: string } }>("pane.zoom", { pane_id: "t1", mode: "toggle" }, socket);
    expect(zoomed.zoom).toMatchObject({ zoomed: true, focused_pane_id: "t1" });
    expect((await sessionSnapshot(socket)).layouts[0]).toMatchObject({ zoomed: true, focused_pane_id: "t1" });
    expect((await herdrRpc<{ zoom: { changed: boolean; reason: string } }>("pane.zoom", { pane_id: "t1", mode: "on" }, socket)).zoom).toMatchObject({ changed: false, reason: "already_zoomed" });
    await herdrRpc("pane.zoom", { pane_id: "t1", mode: "off" }, socket);
    expect((await sessionSnapshot(socket)).layouts[0]!.zoomed).toBe(false);
    await herdrRpc("pane.zoom", { pane_id: "t1", mode: "on" }, socket);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "down" }, socket);
    expect((await sessionSnapshot(socket)).layouts[0]).toMatchObject({ zoomed: false });
  });

  it("moves a pane beside another of its tab in one edit of the document, on every side (#1819)", async () => {
    const { socket, store } = await core([labeled("t1")]);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "right" }, socket);
    const writes = store.writes.length;
    // below t2, t2's half of the tab: herdr-core moves within a tab, so no tab of its own in between
    expect(await paneMoveBeside("t1", "t2", "down", socket)).toEqual({ changed: true, reason: null });
    expect(store.writes).toHaveLength(writes + 1);
    expect(await rects(socket)).toEqual({ t2: { x: 0, y: 0, width: 1000, height: 500 }, t1: { x: 0, y: 500, width: 1000, height: 500 } });
    await paneMoveBeside("t1", "t2", "up", socket);
    expect(await rects(socket)).toEqual({ t1: { x: 0, y: 0, width: 1000, height: 500 }, t2: { x: 0, y: 500, width: 1000, height: 500 } });
    await paneMoveBeside("t1", "t2", "right", socket);
    expect(await rects(socket)).toEqual({ t2: { x: 0, y: 0, width: 500, height: 1000 }, t1: { x: 500, y: 0, width: 500, height: 1000 } });
    await paneMoveBeside("t1", "t2", "left", socket);
    expect(await rects(socket)).toEqual({ t1: { x: 0, y: 0, width: 500, height: 1000 }, t2: { x: 500, y: 0, width: 500, height: 1000 } });
    await herdrRpc("pane.zoom", { pane_id: "t2", mode: "on" }, socket);
    await paneMoveBeside("t1", "t2", "down", socket);
    expect((await sessionSnapshot(socket)).layouts[0]).toMatchObject({ zoomed: false });
  });

  it("moves a pane beside another tab's pane in no tab of its own and refuses where the Herdr app arranges", async () => {
    const { socket, store } = await core([labeled("t1"), labeled("t2"), labeled("t3", "S", "U")]);
    expect(await paneMoveBeside("t1", "t3", "right", socket)).toEqual({ changed: false, reason: "cross_tab" });
    await expect(herdrRpc("pane.move", { pane_id: "t1", destination: { type: "tab", tab_id: "U", target_pane_id: "t3", split: "right" } }, socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(store.writes).toEqual([]);
    store.docs.set("herdr-app", { value: { spaces: [] }, version: 1 });
    await expect(paneMoveBeside("t1", "t2", "down", socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(store.writes).toEqual([]);
  });

  it("reorders workspaces and tabs, Other terminals staying last", async () => {
    const { socket } = await core([labeled("t1", "A", "A1"), labeled("t2", "A", "A2"), labeled("t3", "B", "B1"), terminal("t4")]);
    await herdrRpc("workspace.move", { workspace_id: "B", insert_index: 0 }, socket);
    await herdrRpc("tab.move", { tab_id: "A2", insert_index: 0 }, socket);
    const shown = await sessionSnapshot(socket);
    expect(shown.workspaces.map((workspace) => workspace.workspace_id)).toEqual(["B", "A", "hc-other"]);
    expect(shown.tabs.filter((tab) => tab.workspace_id === "A").map((tab) => tab.tab_id)).toEqual(["A2", "A1"]);
  });

  it("drops a closed pane from its tab and adds one labeled into it from elsewhere to its right", async () => {
    const { socket, terminals } = await core([labeled("t1")]);
    await herdrRpc("pane.split", { target_pane_id: "t1", direction: "down" }, socket);
    terminals.splice(0, 1);
    expect(await rects(socket)).toEqual({ t2: { x: 0, y: 0, width: 1000, height: 1000 } });
    terminals.push(labeled("t9"));
    expect(await rects(socket)).toEqual({ t2: { x: 0, y: 0, width: 500, height: 1000 }, t9: { x: 500, y: 0, width: 500, height: 1000 } });
  });

  it("keeps another client's reorder that landed first, applying this move to the order as it is then", async () => {
    const order = (ids: string[]) => ({ schema: 1, workspaces: ids.map((id) => ({ id, tabs: [{ id: `${id}1`, zoomed: null, root: { leaf: `t${id}` } }] })) });
    const store = documents(0, (docs) => docs.set("ovis-layout", { value: order(["D", "A", "B", "C"]), version: docs.get("ovis-layout")!.version + 1 }));
    store.docs.set("ovis-layout", { value: order(["A", "B", "C", "D"]), version: 1 });
    const { socket } = await core(["A", "B", "C", "D"].map((id) => labeled(`t${id}`, id, `${id}1`)), store);
    await herdrRpc("workspace.move", { workspace_id: "B", insert_index: 4 }, socket);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.workspace_id)).toEqual(["D", "A", "C", "B"]);
  });

  it("moves a workspace dropped after Other terminals to the end, and a tab dropped among helpers' tabs after their parent's", async () => {
    const { socket } = await core([labeled("t1", "A", "A1"), labeled("t2", "A", "A2"), terminal("t5", { parent: "t1" }), labeled("t3", "B", "B1"), terminal("t4")]);
    await herdrRpc("workspace.move", { workspace_id: "A", insert_index: 3 }, socket);
    let shown = await sessionSnapshot(socket);
    expect(shown.workspaces.map((workspace) => workspace.workspace_id)).toEqual(["B", "A", "hc-other"]);
    expect(shown.tabs.filter((tab) => tab.workspace_id === "A").map((tab) => tab.tab_id)).toEqual(["A1", "A:t5", "A2"]);
    await herdrRpc("tab.move", { tab_id: "A2", insert_index: 1 }, socket);
    shown = await sessionSnapshot(socket);
    expect(shown.tabs.filter((tab) => tab.workspace_id === "A").map((tab) => tab.tab_id)).toEqual(["A1", "A:t5", "A2"]);
    await herdrRpc("tab.move", { tab_id: "A2", insert_index: 0 }, socket);
    shown = await sessionSnapshot(socket);
    expect(shown.tabs.filter((tab) => tab.workspace_id === "A").map((tab) => tab.tab_id)).toEqual(["A2", "A1", "A:t5"]);
  });

  it("starts no shell for a split a newer Ovis's layout would refuse, and says when a split pane could not be placed", async () => {
    const foreign = documents();
    foreign.docs.set("ovis-layout", { value: { schema: 2 }, version: 3 });
    const refused = await core([labeled("t1")], foreign);
    expect((await ping(refused.socket)).layout).toEqual({ rename: true, split: false, move: true, arrange: false, worktrees: true });
    await expect(herdrRpc("pane.split", { target_pane_id: "t1", direction: "down" }, refused.socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(refused.terminals.map((held) => held.address)).toEqual(["t1"]);
    const busy = await core([labeled("t1")], documents(2));
    await expect(herdrRpc("pane.split", { target_pane_id: "t1", direction: "down" }, busy.socket)).rejects.toMatchObject({ code: "layout_not_saved" });
    expect(Object.keys(await rects(busy.socket))).toEqual(["t1", "t2"]);
  });

  it("neither reads nor overwrites a layout a newer Ovis wrote, and leaves the Herdr app's document alone", async () => {
    const store = documents();
    store.docs.set("ovis-layout", { value: { schema: 2, anything: true }, version: 4 });
    const { socket } = await core([labeled("t1"), labeled("t2")], store);
    expect(Object.keys(await rects(socket))).toEqual(["t1", "t2"]);
    await expect(herdrRpc("layout.set_split_ratio", { tab_id: "T", path: [], ratio: 0.3 }, socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(store.writes).toEqual([]);
    store.docs.delete("ovis-layout");
    store.docs.set("herdr-app", { value: { spaces: [] }, version: 1 });
    await expect(herdrRpc("pane.zoom", { pane_id: "t1" }, socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(store.writes).toEqual([]);
  });

  it("names a pane in a label, and shows the terminal's own name once it is cleared", async () => {
    const { socket, terminals } = await core([terminal("t1", { name: "shell", labels: { "herdr.space": "S", "herdr.tab": "T" } })]);
    await herdrRpc("pane.rename", { pane_id: "t1", label: "logs" }, socket);
    expect(terminals[0]!.labels).toMatchObject({ "ovis.pane": "logs" });
    expect((await paneGet("t1", socket)).label).toBe("logs");
    await herdrRpc("pane.rename", { pane_id: "t1", label: null }, socket);
    expect((await paneGet("t1", socket)).label).toBe("shell");
  });

  // What each layout method asks hc today, in order: the behaviour of record for moving the layout
  // operations out of the adapter. Workspace A holds tab A1 (t1 beside t2) and tab A2 (t3), B holds B1 (t4).
  describe("the hc calls of each layout method", () => {
    const known = (zoomed: string | null = null, ratio = 0.5) => ({ schema: 1, workspaces: [
      { id: "A", tabs: [
        { id: "A1", zoomed, root: { split: "right", ratio, first: { leaf: "t1" }, second: { leaf: "t2" } } },
        { id: "A2", zoomed: null, root: { leaf: "t3" } },
      ] },
      { id: "B", tabs: [{ id: "B1", zoomed: null, root: { leaf: "t4" } }] },
    ] });
    /**
     * One request on a core holding `layout` at version 1 in `docs`, its handlers changed by `adjust`: its answer (or refusal
     * code), the store, and the hc calls it made, a document's name after `doc.*`.
     */
    const callsOf = async (method: string, params: Record<string, unknown>, layout: unknown = known(), docs = documents(), adjust = (handlers: Record<string, Handler>) => handlers) => {
      docs.docs.set("ovis-layout", { value: layout, version: 1 });
      const store = { ...docs, handlers: adjust({ ...docs.handlers, "terminal.kill": () => ({}), "terminal.rm": () => ({}) }) as typeof docs.handlers };
      const { socket, cores } = await core([
        terminal("t1", { labels: { "herdr.space": "A", "herdr.tab": "A1", "ovis.pane": "logs" } }), labeled("t2", "A", "A1"), labeled("t3", "A", "A2"), labeled("t4", "B", "B1"),
      ], store);
      const from = cores.flatMap((held) => held.calls).length;
      const answer = await herdrRpc(method, params, socket).catch((error: unknown) => ({ refused: error instanceof HerdrError ? error.code : String(error) }));
      const steps = cores.flatMap((held) => held.calls).slice(from).map((call) => (call.method.startsWith("doc.") ? `${call.method} ${String(call.params["name"])}` : call.method));
      return { answer, store, steps };
    };
    /** a snapshot: the terminals and both documents at once */
    const SNAPSHOT = ["terminal.list", "doc.get herdr-app", "doc.get ovis-layout"];
    /** an edit: Ovis's document first, then the terminals and the app's document, then the write at the version read */
    const EDIT = ["doc.get ovis-layout", "terminal.list", "doc.get herdr-app", "doc.set ovis-layout"];
    const EDIT_UNCHANGED = ["doc.get ovis-layout", "terminal.list", "doc.get herdr-app"];

    const edits: [string, Record<string, unknown>, string[]][] = [
      ["pane.split", { target_pane_id: "t1", direction: "down" }, [...SNAPSHOT, "terminal.get", "doc.get ovis-layout", "terminal.run", ...SNAPSHOT, ...EDIT, ...SNAPSHOT]],
      ["layout.set_split_ratio", { tab_id: "A1", path: [], ratio: 0.3 }, [...EDIT]],
      ["pane.resize", { pane_id: "t1", direction: "right", amount: 0.1 }, [...EDIT, ...SNAPSHOT]],
      ["pane.swap", { pane_id: "t1", direction: "right" }, [...EDIT, ...SNAPSHOT]],
      ["pane.zoom", { pane_id: "t1" }, [...EDIT, ...SNAPSHOT]],
      ["pane.move", { pane_id: "t1", destination: { type: "tab", tab_id: "A1", target_pane_id: "t2", split: "down" } }, [...EDIT, ...SNAPSHOT]],
      ["tab.move", { tab_id: "A2", insert_index: 0 }, [...SNAPSHOT, ...EDIT, ...SNAPSHOT]],
      ["workspace.move", { workspace_id: "B", insert_index: 0 }, [...SNAPSHOT, ...EDIT]],
    ];
    // a name, a move to another workspace and a close are labels and ends: the document follows the terminals
    const relabels: [string, Record<string, unknown>, string[]][] = [
      ["pane.move", { pane_id: "t3", destination: { type: "new_tab", workspace_id: "B" } }, [...SNAPSHOT, "terminal.label", ...SNAPSHOT]],
      ["workspace.rename", { workspace_id: "A", label: "api" }, [...SNAPSHOT, "terminal.label", "terminal.label", "terminal.label"]],
      ["tab.rename", { tab_id: "A1", label: "main" }, [...SNAPSHOT, "terminal.label", "terminal.label"]],
      ["pane.rename", { pane_id: "t2", label: "build" }, [...SNAPSHOT, "terminal.label"]],
      ["pane.close", { pane_id: "t3" }, [...SNAPSHOT, "terminal.kill", "terminal.rm"]],
      ["tab.close", { tab_id: "A2" }, [...SNAPSHOT, "terminal.kill", "terminal.rm"]],
      ["workspace.close", { workspace_id: "B" }, [...SNAPSHOT, "terminal.kill", "terminal.rm"]],
    ];
    // a new workspace or tab is a shell labeled into place: the document follows it too
    const shells: [string, Record<string, unknown>, string[]][] = [
      ["workspace.create", { label: "web" }, ["terminal.run", ...SNAPSHOT]],
      ["tab.create", { workspace_id: "A" }, [...SNAPSHOT, "terminal.run", ...SNAPSHOT]],
    ];
    for (const [method, params, expected] of [...edits, ...relabels, ...shells]) {
      const destination = (params["destination"] as { type: string } | undefined)?.type;
      it(`${method}${destination ? ` to ${destination}` : ""} asks hc in today's order`, async () => {
        const { answer, steps } = await callsOf(method, params);
        expect(answer).not.toHaveProperty("refused");
        expect(steps).toEqual(expected);
      });
    }

    it("reads Ovis's document before the terminals in every edit it writes", async () => {
      for (const [method, params] of edits) {
        const { steps } = await callsOf(method, params);
        const write = steps.indexOf("doc.set ovis-layout");
        const read = steps.lastIndexOf("doc.get ovis-layout", write);
        expect([method, write > -1, read > -1, read < steps.lastIndexOf("terminal.list", write)]).toEqual([method, true, true, true]);
      }
    });

    it("makes the whole edit again, Ovis's document first, when one other writer came first", async () => {
      const { answer, steps, store } = await callsOf("layout.set_split_ratio", { tab_id: "A1", path: [], ratio: 0.3 }, known(), documents(1));
      expect(answer).toEqual({ type: "ok" });
      expect(steps).toEqual([...EDIT, ...EDIT]);
      expect(store.docs.get("ovis-layout")!.version).toBe(3);
    });

    it("makes the edit once when the write fails for any reason but another writer", async () => {
      const unavailable = (): never => { throw Object.assign(new Error("busy"), { kind: "unavailable" }); };
      const { answer, steps } = await callsOf("layout.set_split_ratio", { tab_id: "A1", path: [], ratio: 0.3 }, known(), documents(), (handlers) => ({ ...handlers, "doc.set": unavailable }));
      expect(answer).toEqual({ refused: "server_unavailable" });
      expect(steps).toEqual([...EDIT]);
    });

    // FakeCore answers a call as it arrives, so an answer cannot be held: an edit whose first read fails shows
    // instead that the terminals are asked only once Ovis's document has been answered
    it("asks nothing more in an edit whose read of Ovis's document fails", async () => {
      const { answer, steps } = await callsOf("layout.set_split_ratio", { tab_id: "A1", path: [], ratio: 0.3 }, known(), documents(), (handlers) => ({
        ...handlers,
        "doc.get": (params) => {
          if (params["name"] === "ovis-layout") throw Object.assign(new Error("busy"), { kind: "unavailable" });
          return handlers["doc.get"]!(params);
        },
      }));
      expect(answer).toEqual({ refused: "server_unavailable" });
      expect(steps).toEqual(["doc.get ovis-layout"]);
    });

    it("asks hc nothing for an edit on a core that writes no documents", async () => {
      const { answer, steps } = await callsOf("pane.zoom", { pane_id: "t1" }, known(), documents(), (handlers) => Object.fromEntries(Object.entries(handlers).filter(([name]) => name !== "doc.set")));
      expect(answer).toEqual({ refused: "unsupported" });
      expect(steps).toEqual([]);
    });

    // each edit that finds nothing to change: its answer, and no write
    const unchanged: [string, string, Record<string, unknown>, Record<string, unknown>, ReturnType<typeof known>?][] = [
      ["pane.resize", "a pane with no border", { pane_id: "t3", direction: "right" }, { resize: { changed: false, reason: "unchanged" } }],
      ["pane.resize", "a divider at its limit", { pane_id: "t1", direction: "left", amount: 0.5 }, { resize: { changed: false, reason: "unchanged" } }, known(null, 0.1)],
      ["pane.swap", "toward no neighbour", { pane_id: "t1", direction: "left" }, { swap: { changed: false, reason: "no_neighbor", target_pane_id: null } }],
      ["pane.swap", "with itself", { pane_id: "t1", target_pane_id: "t1" }, { swap: { changed: false, reason: "same_pane", target_pane_id: "t1" } }],
      ["pane.swap", "with another tab's pane", { pane_id: "t1", target_pane_id: "t3" }, { swap: { changed: false, reason: "cross_tab", target_pane_id: "t3" } }],
      ["pane.zoom", "of a tab's only pane", { pane_id: "t3" }, { zoom: { changed: false, reason: "single_pane", zoomed: false } }],
      ["pane.zoom", "off where nothing is zoomed", { pane_id: "t1", mode: "off" }, { zoom: { changed: false, reason: "already_unzoomed", zoomed: false } }],
      ["pane.zoom", "on where it is zoomed", { pane_id: "t1", mode: "on" }, { zoom: { changed: false, reason: "already_zoomed", zoomed: true } }, known("t1")],
      ["pane.move", "beside itself", { pane_id: "t1", destination: { type: "tab", tab_id: "A1", target_pane_id: "t1", split: "down" } }, { move_result: { changed: false, reason: "same_pane" } }],
      ["layout.set_split_ratio", "where no split is", { tab_id: "A2", path: [], ratio: 0.3 }, { refused: "split_not_found" }],
      // a name as it is: labeled again, never a document
      ["pane.rename", "to the name it has", { pane_id: "t1", label: "logs" }, { type: "ok" }],
    ];
    for (const [method, what, params, answered, layout] of unchanged) {
      it(`${method} ${what} writes no document`, async () => {
        const { answer, steps, store } = await callsOf(method, params, layout);
        expect(answer).toMatchObject(answered);
        expect(steps.filter((step) => step.startsWith("doc.set"))).toEqual([]);
        expect(steps.slice(0, 3)).toEqual(method === "pane.rename" ? SNAPSHOT : EDIT_UNCHANGED);
        expect(store.writes).toEqual([]);
      });
    }

    // Today these write the document again even though it comes out the same: pinned as they are.
    const rewrites: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["layout.set_split_ratio", { tab_id: "A1", path: [], ratio: 0.5 }, { type: "ok" }],
      ["tab.move", { tab_id: "A1", insert_index: 0 }, { type: "tab_list" }],
      ["workspace.move", { workspace_id: "A", insert_index: 0 }, { type: "ok" }],
      ["pane.move", { pane_id: "t2", destination: { type: "tab", tab_id: "A1", target_pane_id: "t1", split: "right" } }, { move_result: { changed: true, reason: null } }],
    ];
    for (const [method, params, answered] of rewrites) {
      it(`${method} to where it already is writes the same document again`, async () => {
        const { answer, steps, store } = await callsOf(method, params);
        expect(answer).toMatchObject(answered);
        expect(steps.filter((step) => step.startsWith("doc.set"))).toEqual(["doc.set ovis-layout"]);
        expect(store.docs.get("ovis-layout")).toEqual({ value: known(), version: 2 });
      });
    }
  });
});

describe("another machine of the core, as its own PC (#2497)", () => {
  const listed = () => [terminal("t5", { cwd: "/here" }), terminal("lab/t1", { cwd: "/there", pid: 41, foreground: { name: "bash", pid: 41 } }), terminal("lab/t2", { parent: "lab/t1" }), terminal("vps/t1")];
  const LAB_LAYOUT = { spaces: [{ id: "lab-s1", name: "lab work", tabs: [{ id: "lab-s1t1", name: "", root: { type: "row", id: "r", children: [{ type: "block", id: "b1", content: { terminal: "t1" } }] } }] }] };

  it("shows only that machine's terminals, by its own addresses, laid out by its own document", async () => {
    const { socket, cores } = await setup(listed(), { "doc.get": (params) => ({ value: params["on"] === "lab-id" ? LAB_LAYOUT : LAYOUT, version: 1 }) }, undefined, "lab");
    const snapshot = await sessionSnapshot(socket);
    expect(snapshot.workspaces.map((w) => w.label)).toEqual(["lab work"]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.cwd, p.parent_pane_id ?? null])).toEqual([["t1", "/there", null], ["t2", "/home/u", "t1"]]);
    expect(cores[0]!.calls.filter((call) => call.method === "doc.get").map((call) => call.params["on"])).toEqual(["lab-id", "lab-id"]);
  });

  it("reaches each terminal by its address on the core, and starts a new one there", async () => {
    let started: Record<string, unknown> = {};
    const { socket, cores } = await setup(listed(), {
      "terminal.run": (params) => {
        started = params;
        return terminal("lab/t9", { labels: params["labels"] as Record<string, string> });
      },
    }, undefined, "lab");
    await paneSendKeys("t1", ["Up"], socket);
    expect(cores[0]!.calls.find((call) => call.method === "terminal.keys")?.params).toEqual({ terminal: "lab-id/t1", keys: ["up"] });
    const failure = await paneSendText("vps/t1", "x", socket).then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(failure).toBe("pane_not_found");
    await workspaceCreate({ label: "new" }, socket).catch(() => null);
    expect(started["on"]).toBe("lab-id");
  });

  it("reaches no other machine that took its name after a rename", async () => {
    // lab was renamed, and vps took the name lab: its id is not lab's
    const { socket, cores } = await setup(listed(), { "machine.list": () => ({ machines: [{ name: "lab", id: "vps-id", host: "vps", state: "connected", target: "vps", version: "0.1.17" }] }) }, undefined, "lab");
    const failure = await paneSendText("t1", "x", socket).then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(failure).toBe("connect_failed");
    expect(cores[0]!.typed).toEqual([]);
    expect(cores[0]!.calls.filter((call) => call.method !== "machine.list" && call.method !== "hello")).toEqual([]);
  });

  it("tells no process of that machine, and opens no checkout here", async () => {
    const { socket } = await setup(listed(), {}, undefined, "lab");
    expect(await paneProcessInfo("t1", socket)).toEqual({ pane_id: "t1", shell_pid: null, foreground_process_group_id: null, foreground_processes: [] });
    expect((await ping(socket)).layout?.worktrees).toBe(false);
    const refused = await worktreeList("lab-s1", socket).then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(refused).toBe("unsupported");
  });

  it("offers and starts an agent there from Linux or macOS by what hc says runs in its shell", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const shell = { pid: 41, name: "bash" };
      const record = terminal("lab/t1", { pid: 41, argv: ["/bin/bash"], foreground: shell });
      const holder: { cores: FakeCore[] } = { cores: [] };
      const ready = await setup([record], { "terminal.get": () => ({ ...record, foreground: holder.cores[0]?.typed.length ? { pid: 42, name: "claude" } : shell }) }, undefined, "lab", { platform, processTable: () => { throw new Error("no process table off Windows"); } });
      holder.cores = ready.cores;
      expect((await agentManifests(ready.socket)).manifests.map((manifest) => manifest.agent)).toContain("claude");
      await agentStart({ name: "x", kind: "claude", paneId: "t1" }, ready.socket);
      expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'claude'\r");
    }
  });

  // hc names no platform: that machine's is read off its folders, the process in front's first (#3319)
  it("names that machine's process in front by its own platform, and again as a foreground event tells a new folder", async () => {
    let channel = 0;
    const shim = { pid: 42, name: "letta.cmd", argv: ["letta.cmd"] };
    const { socket, cores } = await setup(listed(), {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [terminal("lab/t1", { cwd: "", foreground: shim })] };
      },
    }, undefined, "lab");
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.updated" }, { type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores.at(-1)!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "lab/t1", data: { status: { state: "working" } } });
    core.notify(channel, "event", { seq: 3, type: "foreground", terminal: "lab/t1", data: { ...shim, pid: 43, cwd: "C:\\Users\\u" } });
    core.notify(channel, "event", { seq: 4, type: "foreground", terminal: "lab/t1", data: { pid: 44, name: "cmd", argv: ["cmd"], cwd: "/home/u" } });
    core.notify(channel, "missed", { seq: 9, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: null } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "letta" } },
      { event: "pane.updated", data: { type: "pane_updated", pane_id: "t1" } },
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "cmd" } },
    ]);
  });

  it("streams that machine's events as its own, and none of this PC's or another machine's", async () => {
    let channel = 0;
    const { socket, cores } = await setup(listed(), {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: listed() };
      },
    }, undefined, "lab");
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.created" }, { type: "layout.updated" }, { type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores.at(-1)!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t1", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "event", { seq: 3, type: "created", terminal: "vps/t3", data: { address: "vps/t3", state: "live", turn: 0 } });
    core.notify(channel, "event", { seq: 4, type: "doc", data: { name: "herdr-app", version: 2 } });
    core.notify(channel, "event", { seq: 5, type: "status", terminal: "lab/t1", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "event", { seq: 6, type: "doc", machine: "lab", data: { name: "herdr-app", version: 2 } });
    core.notify(channel, "event", { seq: 7, type: "created", terminal: "lab/t4", data: { address: "lab/t4", state: "live", turn: 0, parent: "lab/t1" } });
    core.notify(channel, "missed", { seq: 8, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "working", agent: "codex" } },
      { event: "layout.updated", data: { type: "layout_updated" } },
      { event: "pane.created", data: { type: "pane_created", pane_id: "t4" } },
    ]);
  });
});
