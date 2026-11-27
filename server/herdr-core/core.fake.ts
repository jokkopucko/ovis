/**
 * A herdr-core for tests: a model of hc behind `HcTransport` (in process) or a unix socket (for a
 * test that runs the real entry), typed against hc's schema. Test tooling only: no product file
 * imports it.
 *
 * What it carries is what probe c measured on hc 0.1.17 and 0.1.18 (docs/tui/decisions.md):
 * - Size: the terminal takes the advertised size of the non-observer viewer with the latest
 *   activity stamp; a viewer without one ranks lowest, and among those the newest attach wins; with
 *   no viewer it runs at 200x120. A stamp is an attach without `resumed`, DATA, any RESIZE (also to
 *   the size already advertised or the current one) and FOCUS 1; never a `resumed` attach,
 *   AUTOMATIC_INPUT, FOCUS 0, FACTS or `display`. A detach works the size out again. Only a change
 *   sends one `size` event, and no viewer ever gets a RESIZE frame. The event for a size an attach
 *   itself set goes out after that attach's reply, never before it: behind the first bytes of its
 *   stream, or ahead of them when the attaching line's event stream has carried nothing yet (a
 *   screen's first attach on a new line), as both real cores send it (core.fake.live.test.ts, "k2").
 *   The event for an earlier change is out before that reply here, unless `late` holds it back. A
 *   real core lets the reply of a line's attach overtake the event of a change another viewer made
 *   just before it. How often is the core's timing and depends on who else listens to its events:
 *   with the two attaches written in one turn, runs of 1,200 races gave 17 to 41 percent with
 *   nobody else viewing and 35 to 51 percent beside an idle viewer that stays where every line
 *   listened, and 10 to 20 and 18 to 36 percent where only this line did. Those are ranges of the
 *   runs of one verification, not bounds (docs/tui/parity.md has these and the other runs). That
 *   event then comes behind the reply and the first bytes, and before the attach's own event
 *   (core.fake.live.test.ts, "k3").
 * - Focus: FOCUS 1 and 0 hand a program that turned mode 1004 on `ESC[I` and `ESC[O` (FOCUS 0 also
 *   from a viewer that never sent FOCUS 1); kind 6 bytes reach the program as they are when the
 *   core names `automatic_input` in hello (1004 or not), and are dropped when it does not.
 * - The stream: the first paint starts with CAN and ends with `CSI 0m CSI ?9001l` (or `h`), and what
 *   follows the mark may share its frame; 256 KiB of credit, chunks of at most 16 KiB, nothing past
 *   the credit; a program's CLOSE waits behind its output; a viewer's own CLOSE is answered at once.
 * - A core that is stopped (`hc server stop`): each live terminal finishes with reason `server_stop`
 *   (signal 1), its viewers' streams hear that CLOSE first and the `finished` event after it, and then
 *   every line ends; the event stream gets no CLOSE of its own (core.fake.live.test.ts, both versions).
 * - Calls and errors in hc's shapes (codes, `data.kind`, `hint`), as an isolated core answered them.
 *
 * Not modelled: plain mode past hello, observers' `resize_notifications` repaints, the 4 MiB
 * backlog repaint, history, the screen itself (a test supplies the paint), document size limits,
 * heartbeat timing (a test sends one), `foreground`, `status` and `turn` events, other machines.
 * One rule is the fake's own: every `doc.set` of `herdr-app` fails and is recorded, so a suite can
 * show Ovis never wrote the desktop app's layout.
 */

import { createServer, type Socket } from "node:net";
import { AUTOMATIC_INPUT_FEATURE, encodeFrame, type Frame, FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE, type HcTransport, makeFrameReader } from "./connection.ts";
import type { AttachResult, CoreInfo, DocGetParams, DocSetParams, EventsSubscribeParams, ExecResult, HcMethod, HcMethods, MachineExecParams, MachineView, Status, Terminal, TerminalAttachParams, TerminalLabelParams, TerminalListParams, TerminalRunParams } from "./hc-api.generated.ts";

/** where a terminal nobody views runs */
export const HEADLESS = { cols: 200, rows: 120 } as const;
/** what a stream may send before the viewer credits it */
export const CREDIT_WINDOW = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;
/** hello's `features` of the two supported releases, as their cores answered */
export const FEATURES_0_1_17: readonly string[] = ["framed", "attach", "events", "status", "shell", "resize_notifications"];
export const FEATURES_0_1_18: readonly string[] = [...FEATURES_0_1_17, AUTOMATIC_INPUT_FEATURE];
/** the frames a viewer sends as its user's (or its terminal's) input: what "nothing was sent" counts */
export const INPUT_KINDS: readonly number[] = [FRAME_DATA, FRAME_RESIZE, FRAME_FOCUS, FRAME_FACTS, FRAME_AUTOMATIC_INPUT];

const ANSWERED = ["hello", "terminal.list", "terminal.get", "terminal.run", "terminal.kill", "terminal.rm", "terminal.label", "terminal.attach", "doc.get", "doc.set", "events.subscribe", "machine.list", "machine.exec"] as const satisfies readonly HcMethod[];
type Answered = Exclude<(typeof ANSWERED)[number], "hello">;
/** what the fake answers a method with: hc's result type, except that a 0.1.17-like core leaves `automatic_input` out of the attach reply, as 0.1.17 does */
type Reply<M extends HcMethod> = M extends "terminal.attach" ? Omit<AttachResult, "automatic_input"> & { automatic_input?: boolean } : HcMethods[M]["result"];
interface Answer<M extends HcMethod> { result: Reply<M>; after?: () => void }
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface FakeCoreOptions {
  /** hello's `version` (default 0.1.18) */
  version?: string;
  /** hello's `features`: leave `automatic_input` out for a core like 0.1.17 (default FEATURES_0_1_18) */
  features?: readonly string[];
  /** hello's `methods`; a method the fake answers but this list leaves out is an unknown method */
  methods?: readonly string[];
  core?: CoreInfo;
  machines?: MachineView[];
  /** Opt-in process execution, owned by the test. */
  readonly exec?: (params: MachineExecParams) => ExecResult;
  /**
   * Asked once for each `size` event and line that hears it (default: never): true holds the event back on that line until the
   * event loop turns or the line sends a frame. An attach the line asks meanwhile gets its reply and first bytes ahead of the held
   * event, and its own event behind it, as a real core sends them. Everything on the line after a held event waits behind it.
   */
  late?: () => boolean;
}

/** One recorded happening, in order: a call and its reply, a frame on a stream channel, an event. */
export type FakeEntry =
  | { what: "call"; line: number; method: string; params: Record<string, unknown> }
  | { what: "reply"; line: number; method: string; result?: unknown; error?: { code: number; kind: string; message: string } }
  | { what: "frame"; from: "viewer" | "core"; line: number; channel: number; kind: number; payload: Uint8Array; terminal: string | null; viewer: number | null }
  | { what: "event"; seq: number; type: string; terminal: string | null; data: unknown };

/** A viewer as the core sees it: its advertised size and whether it has an activity stamp. */
export interface FakeViewer {
  viewer: number;
  line: number;
  channel: number;
  terminal: string;
  cols: number;
  rows: number;
  stamped: boolean;
  observe: boolean;
}

/** The first paint a terminal sends: CAN, `body`, `CSI 0m CSI ?9001{mark}`, then `after` in the same frame or (`split`) the next. */
export interface FakePaint { body: string; mark: "h" | "l"; after: string; split: boolean }

export interface FakeTransport extends HcTransport {
  /** the fake's number for this line, as `FakeEntry.line` and `FakeViewer.line` name it */
  readonly line: number;
}

/** The program in a terminal, scripted by the test: what reached it, what it writes, how it ends. */
export class FakeProgram {
  /** mode 1004, turned on and off by the program's own output */
  focusReports = false;
  /** the pty sizes it was given, in order */
  readonly sizes: string[];
  onInput: ((bytes: Uint8Array) => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;
  private readonly input: Uint8Array[] = [];

  constructor(
    readonly address: string,
    readonly argv: readonly string[],
    size: { cols: number; rows: number },
    private readonly host: { output: (bytes: Uint8Array) => void; exit: (code: number) => void },
  ) {
    this.sizes = [`${size.cols}x${size.rows}`];
  }

  /** every byte the core handed it, as hex */
  receivedHex(): string {
    return Buffer.concat(this.input).toString("hex");
  }

  output(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    for (const mode of Buffer.from(bytes).toString("latin1").matchAll(/\x1b\[\?1004([hl])/g)) this.focusReports = mode[1] === "h";
    this.host.output(bytes);
  }

  exit(code: number): void {
    this.host.exit(code);
  }

  /** the core's side: bytes for its stdin */
  deliver(bytes: Uint8Array): void {
    this.input.push(bytes);
    this.onInput?.(bytes);
  }

  /** the core's side: its pty was resized */
  resized(cols: number, rows: number): void {
    this.sizes.push(`${cols}x${rows}`);
    this.onResize?.(cols, rows);
  }
}

class CallError extends Error {
  constructor(readonly code: number, readonly kind: string, message: string, readonly hint: string) {
    super(message);
  }
}

const notFound = (terminal: string) => new CallError(-32000, "not_found", `no terminal "${terminal}"`, "see `hc ls --all`");
const missing = (field: string) => new CallError(-32602, "invalid_params", `missing field \`${field}\``, "see `hc schema`");

interface Viewer { viewer: number; line: Line; stream: Stream; terminal: string; cols: number; rows: number; stamp: number | null; attached: number; observe: boolean }
interface Held { terminal: Terminal; program: FakeProgram; viewers: Viewer[]; paint: FakePaint; lost: boolean }
type Out = { bytes: Uint8Array } | { close: Uint8Array };

/** One channel of a line: an attach or a subscription, with its credit and what waits for it. */
class Stream {
  credit = CREDIT_WINDOW;
  readonly queue: Out[] = [];
  viewer: Viewer | null = null;
  filter: EventsSubscribeParams | null = null;
  /** an event stream that has sent something */
  carried = false;

  constructor(readonly line: Line, readonly id: number) {}

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.queue.push({ bytes });
    this.flush();
  }

  /** a CLOSE from the core, after whatever output is still queued */
  end(reason: Record<string, unknown> | null): void {
    this.queue.push({ close: reason ? Buffer.from(JSON.stringify(reason)) : new Uint8Array(0) });
    this.flush();
  }

  flush(): void {
    while (this.queue.length > 0 && !this.line.ended) {
      const head = this.queue[0]!;
      if ("close" in head) {
        this.queue.shift();
        this.line.send(this.id, FRAME_CLOSE, head.close, this);
        this.line.channels.delete(this.id);
        continue;
      }
      if (this.credit <= 0) return;
      const size = Math.min(head.bytes.length, this.credit, CHUNK_BYTES);
      const chunk = head.bytes.subarray(0, size);
      this.credit -= size;
      if (size === head.bytes.length) this.queue.shift();
      else head.bytes = head.bytes.subarray(size);
      this.line.send(this.id, FRAME_DATA, chunk, this);
    }
  }
}

/** One connection to the fake, from its hello on. */
class Line {
  ended = false;
  readonly channels = new Map<number, Stream>();
  /** `size` events held back on their way to this line's event streams (`late`), in order */
  readonly held: { stream: Stream; bytes: Uint8Array }[] = [];
  private plain = true;
  private pending = new Uint8Array(0);
  private nextChannel = 1;
  private readonly frames: (chunk: Uint8Array) => void;

  constructor(readonly core: FakeHcCore, readonly id: number, private readonly sink: (bytes: Uint8Array) => void, private readonly hangUp: () => void) {
    this.frames = makeFrameReader((frame) => core.onFrame(this, frame), () => this.end());
  }

  stream(): Stream {
    const stream = new Stream(this, this.nextChannel++);
    this.channels.set(stream.id, stream);
    return stream;
  }

  receive(bytes: Uint8Array): void {
    if (this.ended) return;
    if (!this.plain) {
      this.frames(bytes);
      return;
    }
    const joined = Buffer.concat([this.pending, bytes]);
    const at = joined.indexOf(0x0a);
    if (at === -1) {
      this.pending = joined;
      return;
    }
    this.pending = new Uint8Array(0);
    this.plain = !this.core.onHello(this, joined.subarray(0, at).toString());
    if (at + 1 < joined.length) this.receive(joined.subarray(at + 1));
  }

  /** a plain line before framing (hello's answer) */
  sendLine(message: unknown): void {
    if (!this.ended) this.sink(Buffer.from(`${JSON.stringify(message)}\n`));
  }

  send(channel: number, kind: number, payload: Uint8Array, stream?: Stream): void {
    if (this.ended) return;
    if (channel !== 0) this.core.record(this, "core", channel, kind, payload, stream);
    this.sink(encodeFrame(channel, kind, payload));
  }

  /** the line is over, from either end: its viewers leave, its streams go */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.core.onLineEnded(this);
    this.channels.clear();
    this.hangUp();
  }
}

export class FakeHcCore {
  /** everything that happened, in order */
  readonly log: FakeEntry[] = [];
  /** every `doc.set` of `herdr-app` (each one failed) */
  readonly herdrAppWrites: Record<string, unknown>[] = [];
  /** documents by name */
  readonly docs = new Map<string, { value: unknown; version: number }>();
  /** called for every program the fake starts (`terminal.run`, a restart): the test scripts it here */
  onStart: ((program: FakeProgram) => void) | null = null;
  private readonly exec?: (params: MachineExecParams) => ExecResult;
  private readonly version: string;
  private readonly features: readonly string[];
  private readonly methods: readonly string[];
  private readonly info: CoreInfo;
  private readonly machines: MachineView[];
  private readonly late: (() => boolean) | null;
  private readonly lines = new Map<number, Line>();
  private readonly terminals = new Map<string, Held>();
  private nextLine = 1;
  private nextTerminal = 1;
  private nextViewer = 1;
  private clock = 0;
  private seq = 0;
  private conflicts = 0;
  private readonly refusedFolders = new Set<string>();

  constructor(options: FakeCoreOptions = {}) {
    this.version = options.version ?? "0.1.18";
    this.features = options.features ?? FEATURES_0_1_18;
    this.exec = options.exec;
    this.methods = options.methods ?? ANSWERED.filter(method => method !== "machine.exec" || this.exec !== undefined);
    this.info = options.core ?? { id: "fake0000", name: "fake" };
    this.machines = options.machines ?? [];
    this.late = options.late ?? null;
  }

  /** A new line to the fake, as `hc connect` or the socket would give one. */
  transport(): FakeTransport {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const { promise: exited, resolve } = Promise.withResolvers<unknown>();
    const line = this.open((bytes) => controller.enqueue(bytes), () => {
      try { controller.close(); } catch { /* closed already */ }
      resolve(null);
    });
    return { line: line.id, readable, exited, write: (bytes) => line.receive(bytes), kill: () => line.end() };
  }

  /** Serves the same protocol on a unix socket at `path` until `close()`. */
  async listen(path: string): Promise<{ close: () => Promise<void> }> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      const line = this.open((bytes) => { if (!socket.destroyed) socket.write(bytes); }, () => socket.end());
      socket.on("data", (data: Buffer) => line.receive(new Uint8Array(data)));
      socket.on("close", () => { sockets.delete(socket); line.end(); });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    return {
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    };
  }

  /** A core restart: every line ends (EOF), `seq` starts again; terminals and documents stay. */
  restart(): void {
    for (const line of [...this.lines.values()]) line.end();
    this.seq = 0;
  }

  /**
   * The core is stopped: every live terminal finishes with reason `server_stop`, each of its streams
   * closing with that reason before the `finished` event goes out, and then every line ends.
   */
  stop(): void {
    for (const held of this.terminals.values()) {
      if (held.terminal.state === "live") this.finish(held, { exit_code: null, reason: "server_stop", signal: 1 }, true);
    }
    this.restart();
  }

  private open(sink: (bytes: Uint8Array) => void, hangUp: () => void): Line {
    const line = new Line(this, this.nextLine++, sink, hangUp);
    this.lines.set(line.id, line);
    return line;
  }

  size(terminal: string): string {
    const { cols, rows } = this.held(terminal).terminal;
    return `${cols}x${rows}`;
  }

  terminal(terminal: string): Terminal {
    return structuredClone(this.held(terminal).terminal);
  }

  program(terminal: string): FakeProgram {
    return this.held(terminal).program;
  }

  viewers(terminal?: string): FakeViewer[] {
    const all = [...this.terminals.values()].flatMap((held) => held.viewers);
    return all.filter((viewer) => terminal === undefined || viewer.terminal === terminal).map((viewer) => ({
      viewer: viewer.viewer, line: viewer.line.id, channel: viewer.stream.id, terminal: viewer.terminal, cols: viewer.cols, rows: viewer.rows, stamped: viewer.stamp !== null, observe: viewer.observe,
    }));
  }

  calls(): { line: number; method: string; params: Record<string, unknown> }[] {
    return this.log.flatMap((entry) => entry.what === "call" ? [{ line: entry.line, method: entry.method, params: entry.params }] : []);
  }

  /** What viewers sent on `terminal`'s streams (by default their input frames), described as `DATA 61`, `RESIZE 80x24`, `FOCUS 1`. */
  sentOn(terminal: string, { viewer, kinds = INPUT_KINDS }: { viewer?: number; kinds?: readonly number[] } = {}): string[] {
    return this.frames("viewer", terminal, viewer, kinds).map((entry) => describeFrame(entry.kind, entry.payload));
  }

  /** What the fake sent to `terminal`'s viewers, every kind, described as `sentOn` does. */
  framesTo(terminal: string, { viewer, kinds }: { viewer?: number; kinds?: readonly number[] } = {}): string[] {
    return this.frames("core", terminal, viewer, kinds).map((entry) => describeFrame(entry.kind, entry.payload));
  }

  /** The DATA payloads the fake sent to `terminal`'s viewers, one string per frame. */
  dataTo(terminal: string, viewer?: number): string[] {
    return this.frames("core", terminal, viewer, [FRAME_DATA]).map((entry) => Buffer.from(entry.payload).toString("latin1"));
  }

  /** How many bytes `terminal`'s viewers credited back. */
  credited(terminal: string, viewer?: number): number {
    return this.frames("viewer", terminal, viewer, [FRAME_CREDIT]).reduce((sum, entry) => sum + Buffer.from(entry.payload).readUInt32LE(0), 0);
  }

  /** The events about `terminal` (null: those about no terminal, the `doc` events), as `size 80x24`, `doc name@3` or the type alone. */
  events(terminal: string | null, ...types: string[]): string[] {
    return this.log.flatMap((entry) => {
      if (entry.what !== "event" || entry.terminal !== terminal || (types.length > 0 && !types.includes(entry.type))) return [];
      const data = entry.data as Record<string, unknown>;
      if (entry.type === "size") return [`size ${String(data["cols"])}x${String(data["rows"])}`];
      if (entry.type === "doc") return [`doc ${String(data["name"])}@${String(data["version"])}`];
      return [entry.type];
    });
  }

  private frames(from: "viewer" | "core", terminal: string, viewer: number | undefined, kinds: readonly number[] | undefined) {
    return this.log.flatMap((entry) => entry.what === "frame" && entry.from === from && entry.terminal === terminal && (viewer === undefined || entry.viewer === viewer) && (!kinds || kinds.includes(entry.kind)) ? [entry] : []);
  }

  /** A terminal as `terminal.run` makes one, without a client. */
  spawn(params: TerminalRunParams = {}): Terminal {
    return structuredClone(this.run(params));
  }

  setPaint(terminal: string, paint: Partial<FakePaint>): void {
    const held = this.held(terminal);
    held.paint = { ...held.paint, ...paint };
  }

  /** The next `count` writes of any document find another writer was first (its version moves on). */
  conflictNext(count: number): void {
    this.conflicts = count;
  }

  /** `terminal.run` in `folder` fails as hc's does for a folder it cannot start a program in (removed, mode 000): `spawn_failed`. */
  refuseFolder(folder: string): void {
    this.refusedFolders.add(folder);
  }

  /** A kept terminal's program died by a signal: its streams close, and it waits for `restartTerminal`. */
  lose(terminal: string, signal = 9): void {
    const held = this.held(terminal);
    const end = { exit_code: null, finished_ms: null, reason: "signaled", signal };
    Object.assign(held.terminal, end, { pid: null });
    held.lost = true;
    this.emit("lost", terminal, end);
    for (const viewer of held.viewers.splice(0)) viewer.stream.end(end);
  }

  /** The new shell of a lost terminal: `restarted` with the whole record. */
  restartTerminal(terminal: string): void {
    const held = this.held(terminal);
    held.lost = false;
    Object.assign(held.terminal, { reason: null, signal: null, pid: this.pid(), cols: HEADLESS.cols, rows: HEADLESS.rows });
    held.program = this.startProgram(held.terminal);
    this.emit("restarted", terminal, structuredClone(held.terminal));
    this.onStart?.(held.program);
  }

  /** The record is gone: `removed`, and its viewers' streams end. */
  remove(terminal: string): void {
    const held = this.held(terminal);
    this.emit("removed", terminal, {});
    for (const viewer of held.viewers.splice(0)) viewer.stream.end(null);
    this.terminals.delete(terminal);
  }

  /** An event as it is, changing nothing else (a `size`, `doc` or `finished` the test makes up). */
  emit(type: string, terminal: string | null, data: unknown): void {
    this.seq++;
    this.log.push({ what: "event", seq: this.seq, type, terminal, data });
    const params = terminal === null ? { data, seq: this.seq, type } : { data, seq: this.seq, terminal, type };
    this.notify((filter) => this.hears(filter, terminal), { jsonrpc: "2.0", method: "event", params }, type === "size");
  }

  /**
   * A status written by a pane is also present in the next snapshot. A report that leaves `working` ends a turn, as hc
   * 0.1.17 and 0.1.18 count them: the record's turn rises and a `turn` event with the new state follows the `status`.
   */
  reportStatus(terminal: string, status: Status): void {
    const { terminal: record } = this.held(terminal);
    const ends = record.status?.state === "working" && status.state !== "working";
    record.status = structuredClone(status);
    this.emit("status", terminal, { status: record.status });
    if (!ends) return;
    record.turn = (record.turn ?? 0) + 1;
    this.emit("turn", terminal, { state: status.state, turn: record.turn });
  }

  /** While set, every event and heartbeat waits on its line, in order, until `releaseEvents`: a core that answers before it tells. */
  holdingEvents = false;

  /** What `holdingEvents` held goes out, in order, and events flow again. */
  releaseEvents(): void {
    this.holdingEvents = false;
    for (const line of this.lines.values()) this.release(line);
  }

  /** How many events are held back on their way (`late` sizes, none once the event loop has turned; `holdingEvents`). */
  heldEvents(): number {
    return [...this.lines.values()].reduce((sum, line) => sum + line.held.length, 0);
  }

  heartbeat(): void {
    this.notify(() => true, { jsonrpc: "2.0", method: "heartbeat", params: { seq: this.seq } });
  }

  /** Every subscriber fell behind: a fresh snapshot at the current seq. */
  missed(): void {
    for (const line of this.lines.values()) this.release(line);
    for (const stream of this.subscriptions()) stream.push(lineOf({ jsonrpc: "2.0", method: "missed", params: { seq: this.seq, terminals: this.snapshot(stream.filter!) } }));
  }

  /** @returns whether the line is framed from here on */
  onHello(line: Line, text: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      line.sendLine(errorReply(null, new CallError(-32700, "parse_error", String(error), "see `hc schema`")));
      return false;
    }
    const call = callOf(parsed);
    if ("invalid" in call) {
      line.sendLine(errorReply(call.invalid, MISSING_METHOD));
      return false;
    }
    const id = call.id;
    const message = { method: call.method, params: call.params as { generation?: unknown; framed?: unknown } };
    this.log.push({ what: "call", line: line.id, method: String(message.method), params: { ...message.params } });
    const refusal = message.method !== "hello" ? new CallError(-32000, "unsupported", "this fake speaks framed mode only: send hello with framed true first", "see `hc schema`")
      : message.params?.generation !== 1 ? new CallError(-32000, "unsupported_generation", `generation ${String(message.params?.generation)} is not spoken here`, "this core speaks generation 1")
      : message.params.framed !== true ? new CallError(-32000, "unsupported", "this fake speaks framed mode only", "send hello with framed true")
      : null;
    if (refusal) {
      line.sendLine(errorReply(id, refusal));
      return false;
    }
    const result = { core: this.info, features: [...this.features], framed: true, generation: 1, methods: [...this.methods], version: this.version };
    this.log.push({ what: "reply", line: line.id, method: "hello", result });
    line.sendLine({ id, jsonrpc: "2.0", result });
    return true;
  }

  onFrame(line: Line, frame: Frame): void {
    this.frameOn(line, frame);
    // what was held back for this line goes out behind the answer to its frame
    this.release(line);
  }

  private frameOn(line: Line, frame: Frame): void {
    if (frame.channel === 0) {
      if (frame.kind === FRAME_DATA) this.onCall(line, frame.payload);
      return;
    }
    const stream = line.channels.get(frame.channel);
    this.record(line, "viewer", frame.channel, frame.kind, frame.payload, stream);
    if (!stream) {
      // hc answers a CLOSE on a channel it does not know, and ignores anything else there
      if (frame.kind === FRAME_CLOSE) line.send(frame.channel, FRAME_CLOSE, new Uint8Array(0));
      return;
    }
    if (frame.kind === FRAME_CREDIT) {
      if (frame.payload.length >= 4) stream.credit += Buffer.from(frame.payload).readUInt32LE(0);
      stream.flush();
      return;
    }
    if (frame.kind === FRAME_CLOSE) {
      stream.queue.length = 0;
      line.send(stream.id, FRAME_CLOSE, new Uint8Array(0), stream);
      line.channels.delete(stream.id);
      if (stream.viewer) this.detach(stream.viewer);
      return;
    }
    const viewer = stream.viewer;
    if (!viewer || viewer.observe) return;
    const held = this.terminals.get(viewer.terminal);
    if (!held || held.lost || held.terminal.state !== "live") return;
    switch (frame.kind) {
      case FRAME_DATA:
        this.stamp(held, viewer);
        held.program.deliver(frame.payload);
        return;
      case FRAME_RESIZE: {
        if (frame.payload.length < 4) return;
        const grid = Buffer.from(frame.payload);
        viewer.cols = grid.readUInt16LE(0);
        viewer.rows = grid.readUInt16LE(2);
        this.stamp(held, viewer);
        return;
      }
      case FRAME_FOCUS:
        if (frame.payload[0] === 1) this.stamp(held, viewer);
        if (held.program.focusReports) held.program.deliver(Buffer.from(frame.payload[0] === 1 ? "\x1b[I" : "\x1b[O", "latin1"));
        return;
      case FRAME_AUTOMATIC_INPUT:
        // a core that does not name the feature drops the frame and its bytes, as 0.1.17 does
        if (this.features.includes(AUTOMATIC_INPUT_FEATURE)) held.program.deliver(frame.payload);
        return;
      default:
        // FACTS, and kinds this core does not know: no stamp, nothing for the program
        return;
    }
  }

  onLineEnded(line: Line): void {
    this.lines.delete(line.id);
    line.held.length = 0;
    for (const stream of line.channels.values()) if (stream.viewer) this.detach(stream.viewer);
  }

  record(line: Line, from: "viewer" | "core", channel: number, kind: number, payload: Uint8Array, stream = line.channels.get(channel)): void {
    const viewer = stream?.viewer ?? null;
    this.log.push({ what: "frame", from, line: line.id, channel, kind, payload: new Uint8Array(payload), terminal: viewer?.terminal ?? null, viewer: viewer?.viewer ?? null });
  }

  private onCall(line: Line, payload: Uint8Array): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload).toString());
    } catch (error) {
      line.send(0, FRAME_DATA, Buffer.from(JSON.stringify(errorReply(null, new CallError(-32700, "parse_error", String(error), "see `hc schema`")))));
      return;
    }
    const call = callOf(parsed);
    if ("invalid" in call) {
      line.send(0, FRAME_DATA, Buffer.from(JSON.stringify(errorReply(call.invalid, MISSING_METHOD))));
      return;
    }
    const { id, method, params } = call;
    this.log.push({ what: "call", line: line.id, method, params });
    let after: (() => void) | undefined;
    let reply: unknown;
    try {
      if (!this.methods.includes(method) || !(ANSWERED as readonly string[]).includes(method) || method === "hello") throw new CallError(-32601, "unknown_method", `unknown method "${method}"`, "see `hc schema`");
      const answered = this.answer(line, method as Answered, params);
      after = answered.after;
      this.log.push({ what: "reply", line: line.id, method, result: answered.result });
      reply = { id, jsonrpc: "2.0", result: answered.result };
    } catch (error) {
      const failure = error instanceof CallError ? error : new CallError(-32000, "internal", String(error), "");
      this.log.push({ what: "reply", line: line.id, method, error: { code: failure.code, kind: failure.kind, message: failure.message } });
      reply = errorReply(id, failure);
    }
    line.send(0, FRAME_DATA, Buffer.from(JSON.stringify(reply)));
    // a stream's first frames go out after the reply that names its channel, as hc orders them
    after?.();
  }

  private answer(line: Line, method: Answered, params: Record<string, unknown>): Answer<Answered> {
    const terminalParam = () => {
      if (typeof params["terminal"] !== "string") throw missing("terminal");
      return params["terminal"];
    };
    // one handler per method, each checked against hc's result type for that method
    const handlers: { [M in Answered]: () => Answer<M> } = {
      "machine.exec": () => {
        if (this.exec === undefined) throw new CallError(-32601, "unknown_method", 'unknown method "machine.exec"', "see `hc schema`");
        return { result: this.exec(params) };
      },
      "terminal.list": () => {
        const { all, labels } = params as TerminalListParams;
        const matching = [...this.terminals.values()].map((held) => held.terminal).filter((record) => matches(record, labels));
        const shown = matching.filter((record) => all || record.state === "live");
        return { result: { terminals: structuredClone(shown), hidden_finished: matching.length - shown.length, machines: structuredClone(this.machines) } };
      },
      "terminal.get": () => ({ result: structuredClone(this.held(terminalParam(), true).terminal) }),
      "terminal.run": () => ({ result: structuredClone(this.run(params as TerminalRunParams)) }),
      "terminal.kill": () => {
        const held = this.held(terminalParam(), true);
        if (held.terminal.state === "live") this.finish(held, { exit_code: null, reason: "killed", signal: 1 });
        return { result: structuredClone(held.terminal) };
      },
      "terminal.rm": () => {
        const terminal = terminalParam();
        const held = this.held(terminal, true);
        if (held.terminal.state === "live") throw new CallError(-32000, "live", `${terminal} is still running`, `kill it first: hc kill ${terminal}`);
        this.remove(terminal);
        return { result: { removed: terminal } };
      },
      "terminal.label": () => {
        const { labels } = params as unknown as TerminalLabelParams;
        if (typeof labels !== "object" || labels === null) throw missing("labels");
        const held = this.held(terminalParam(), true);
        for (const [key, value] of Object.entries(labels)) {
          if (value === "") delete held.terminal.labels[key];
          else held.terminal.labels[key] = value;
        }
        this.emit("labels", held.terminal.address, { labels: { ...held.terminal.labels } });
        return { result: structuredClone(held.terminal) };
      },
      "terminal.attach": () => this.attach(line, params as unknown as TerminalAttachParams),
      "events.subscribe": () => {
        const stream = line.stream();
        stream.filter = params as EventsSubscribeParams;
        return { result: { channel: stream.id, seq: this.seq, terminals: this.snapshot(stream.filter) } };
      },
      "doc.get": () => ({ result: structuredClone(this.docs.get(docName(params as unknown as DocGetParams)) ?? { value: null, version: 0 }) }),
      "doc.set": () => ({ result: this.setDoc(params as unknown as DocSetParams) }),
      "machine.list": () => ({ result: { machines: structuredClone(this.machines) } }),
    };
    return handlers[method]();
  }

  private run(params: TerminalRunParams): Terminal {
    if (typeof params.cwd === "string" && this.refusedFolders.has(params.cwd)) {
      throw new CallError(-32000, "spawn_failed", `cannot start a program in "${params.cwd}"`, "check that the folder exists and can be entered");
    }
    if (params.on && !this.machines.some((machine) => machine.name === params.on)) {
      throw new CallError(-32000, "machine_unknown", `unknown machine "${params.on}"`, this.machines.length === 0 ? "no machines yet: hc machine add <ssh-target>" : "see `hc machine list`");
    }
    const number = this.nextTerminal++;
    const address = params.on ? `${params.on}/t${number}` : `t${number}`;
    const size = params.size ?? HEADLESS;
    const terminal: Terminal = {
      address, argv: params.argv ?? (params.line ? ["sh", "-c", params.line] : ["sh"]), cols: size.cols, created_ms: Date.now(), cwd: params.cwd ?? "/",
      die_with_parent: false, exit_code: null, finished_ms: null, identity: "ghostty", keep: params.keep ?? false, labels: { ...params.labels }, name: params.name ?? null,
      notify: !params.no_notify, parent: params.parent ?? null, pid: this.pid(), reason: null, reported: false, rm: params.rm ?? false, rows: size.rows, screen: "exact", signal: null,
      state: "live", status: null, status_ms: null, template: null, title: "", turn: 0,
    };
    const held: Held = { terminal, program: this.startProgram(terminal), viewers: [], paint: { body: "", mark: "l", after: "", split: false }, lost: false };
    this.terminals.set(address, held);
    this.emit("created", address, structuredClone(terminal));
    this.onStart?.(held.program);
    return terminal;
  }

  private startProgram(terminal: Terminal): FakeProgram {
    const address = terminal.address;
    return new FakeProgram(address, terminal.argv, terminal, {
      output: (bytes) => {
        const held = this.terminals.get(address);
        if (!held || held.lost || held.terminal.state !== "live") return;
        for (const viewer of held.viewers) viewer.stream.push(bytes);
      },
      exit: (code) => {
        const held = this.terminals.get(address);
        if (held && held.terminal.state === "live") this.finish(held, { exit_code: code, reason: "exited", signal: null });
      },
    });
  }

  private attach(line: Line, params: TerminalAttachParams): Answer<"terminal.attach"> {
    if (typeof params.terminal !== "string") throw missing("terminal");
    if (typeof params.cols !== "number") throw missing("cols");
    if (typeof params.rows !== "number") throw missing("rows");
    const held = this.held(params.terminal, true);
    if (held.terminal.state !== "live") throw new CallError(-32000, "finished", `${params.terminal} has finished`, `read what it left: hc read ${params.terminal}`);
    if (held.lost) throw new CallError(-32000, "unavailable", `${params.terminal} is lost, waiting for its new shell`, "attach again after `restarted`");
    const stream = line.stream();
    const observe = params.observe === true;
    const viewer: Viewer = { viewer: this.nextViewer++, line, stream, terminal: params.terminal, cols: params.cols, rows: params.rows, stamp: null, attached: ++this.clock, observe };
    stream.viewer = viewer;
    held.viewers.push(viewer);
    // the size this attach sets is in its reply at once; the event that tells of it follows the reply, on either side of the first bytes
    const ahead = [...line.channels.values()].some((other) => other.filter !== null && !other.carried);
    let told: (() => void) | null = null;
    const later = (tell: () => void) => { told = tell; };
    if (!params.resumed && !observe) this.stamp(held, viewer, later);
    else this.settle(held, later);
    const automatic = this.features.includes(AUTOMATIC_INPUT_FEATURE) ? { automatic_input: true } : {};
    const result = { ...automatic, channel: stream.id, resize_notifications: false, terminal: structuredClone(held.terminal) };
    const { body, mark, after, split } = held.paint;
    const paint = `\x18${body}\x1b[0m\x1b[?9001${mark}`;
    return {
      result,
      after: () => {
        // an event held back for this line (`late`) is from before this attach: it goes out ahead of the attach's own event
        if (ahead) {
          this.release(line);
          told?.();
        }
        stream.push(Buffer.from(split ? paint : paint + after, "latin1"));
        if (split) stream.push(Buffer.from(after, "latin1"));
        if (!ahead) {
          this.release(line);
          told?.();
        }
      },
    };
  }

  private detach(viewer: Viewer): void {
    const held = this.terminals.get(viewer.terminal);
    if (!held) return;
    const at = held.viewers.indexOf(viewer);
    if (at === -1) return;
    held.viewers.splice(at, 1);
    this.settle(held);
  }

  private stamp(held: Held, viewer: Viewer, announce?: (tell: () => void) => void): void {
    viewer.stamp = ++this.clock;
    this.settle(held, announce);
  }

  /**
   * The size rule: the latest stamp leads, else the newest attach; nobody (or only observers) means HEADLESS.
   * A change is told in a `size` event: at once, or when `announce` (an attach) says so.
   */
  private settle(held: Held, announce: (tell: () => void) => void = (tell) => tell()): void {
    if (held.lost || held.terminal.state !== "live") return;
    const rank = (viewer: Viewer) => [viewer.stamp ?? -1, viewer.attached] as const;
    const voters = held.viewers.filter((viewer) => !viewer.observe);
    const lead = voters.reduce<Viewer | null>((best, viewer) => {
      if (!best) return viewer;
      const [stamp, attached] = rank(viewer);
      const [bestStamp, bestAttached] = rank(best);
      return stamp > bestStamp || (stamp === bestStamp && attached > bestAttached) ? viewer : best;
    }, null);
    const { cols, rows } = lead ?? HEADLESS;
    if (cols === held.terminal.cols && rows === held.terminal.rows) return;
    held.terminal.cols = cols;
    held.terminal.rows = rows;
    held.program.resized(cols, rows);
    announce(() => this.emit("size", held.terminal.address, { cols, rows }));
  }

  /** A terminal ends: the `finished` event, then its streams' CLOSE; a stopping core (`closeFirst`) closes the streams first. */
  private finish(held: Held, end: { exit_code: number | null; reason: string; signal: number | null }, closeFirst = false): void {
    const payload = { exit_code: end.exit_code, finished_ms: Date.now(), reason: end.reason, signal: end.signal };
    Object.assign(held.terminal, payload, { state: "finished" });
    const close = () => { for (const viewer of held.viewers.splice(0)) viewer.stream.end(payload); };
    if (closeFirst) close();
    this.emit("finished", held.terminal.address, payload);
    close();
  }

  private setDoc(params: DocSetParams): { version: number } {
    const name = docName(params);
    if (name === "herdr-app") {
      this.herdrAppWrites.push({ ...params });
      throw new CallError(-32000, "refused", "this fake refuses every doc.set of herdr-app: Ovis never writes the desktop app's layout", "write ovis-layout instead");
    }
    if (typeof params.version !== "number") throw missing("version");
    const stored = this.docs.get(name) ?? { value: null, version: 0 };
    if (this.conflicts > 0) {
      this.conflicts--;
      this.docs.set(name, { ...stored, version: stored.version + 1 });
      this.emit("doc", null, { name, version: stored.version + 1 });
      throw conflict(name, stored.version + 1, params.version);
    }
    if (params.version !== stored.version) throw conflict(name, stored.version, params.version);
    const version = stored.version + 1;
    this.docs.set(name, { value: structuredClone(params.value ?? null), version });
    this.emit("doc", null, { name, version });
    return { version };
  }

  private snapshot(filter: EventsSubscribeParams): Terminal[] {
    return structuredClone([...this.terminals.values()].map((held) => held.terminal).filter((record) => this.hears(filter, record.address)));
  }

  /** Whether a subscription with `filter` hears an event about `terminal` (null: a doc event, heard only unfiltered). */
  private hears(filter: EventsSubscribeParams, terminal: string | null): boolean {
    const filtered = Boolean(filter.terminal) || Boolean(filter.children_of) || Object.keys(filter.labels ?? {}).length > 0;
    if (terminal === null) return !filtered;
    const record = this.terminals.get(terminal)?.terminal;
    if (!record) return false;
    return (!filter.terminal || filter.terminal === terminal) && (!filter.children_of || record.parent === filter.children_of) && matches(record, filter.labels);
  }

  private subscriptions(): Stream[] {
    return [...this.lines.values()].flatMap((line) => [...line.channels.values()].filter((stream) => stream.filter !== null));
  }

  private notify(heard: (filter: EventsSubscribeParams) => boolean, message: unknown, size = false): void {
    for (const stream of this.subscriptions()) {
      if (!heard(stream.filter!)) continue;
      stream.carried = true;
      const { line } = stream;
      if (this.holdingEvents || (size && (line.held.length > 0 || this.late?.() === true))) {
        if (!this.holdingEvents && line.held.length === 0) setImmediate(() => this.release(line));
        line.held.push({ stream, bytes: lineOf(message) });
        continue;
      }
      this.release(line);
      stream.push(lineOf(message));
    }
  }

  /** What was held back for `line` (`late`) goes out, in order. */
  private release(line: Line): void {
    if (this.holdingEvents) return;
    for (const { stream, bytes } of line.held.splice(0)) if (line.channels.get(stream.id) === stream) stream.push(bytes);
  }

  private held(terminal: string, asCall = false): Held {
    const held = this.terminals.get(terminal);
    if (held) return held;
    if (asCall) throw notFound(terminal);
    throw new Error(`the fake has no terminal ${terminal}`);
  }

  private pid(): number {
    return 400_000 + this.clock++;
  }
}

/** A frame as the tests compare it: `DATA 61`, `RESIZE 80x24`, `FOCUS 1`, `FACTS {...}`, `AUTOMATIC_INPUT 1b5b49`, `CREDIT 300`, `CLOSE`. */
export function describeFrame(kind: number, payload: Uint8Array): string {
  const bytes = Buffer.from(payload);
  switch (kind) {
    case FRAME_DATA: return `DATA ${bytes.toString("hex")}`;
    case FRAME_CREDIT: return `CREDIT ${bytes.length >= 4 ? bytes.readUInt32LE(0) : "?"}`;
    case FRAME_CLOSE: return bytes.length === 0 ? "CLOSE" : `CLOSE ${bytes.toString()}`;
    case FRAME_RESIZE: return bytes.length >= 4 ? `RESIZE ${bytes.readUInt16LE(0)}x${bytes.readUInt16LE(2)}` : `RESIZE ${bytes.toString("hex")}`;
    case FRAME_FOCUS: return `FOCUS ${bytes[0] ?? "?"}`;
    case FRAME_FACTS: return `FACTS ${bytes.toString()}`;
    case FRAME_AUTOMATIC_INPUT: return `AUTOMATIC_INPUT ${bytes.toString("hex")}`;
    default: return `KIND ${kind} ${bytes.toString("hex")}`;
  }
}

/** what hc answers a message that is JSON but not a call: the message's id when it is an object that has one */
const MISSING_METHOD = new CallError(-32600, "invalid_request", "missing method", "see `hc schema`");

/** A parsed message as a call, or (`invalid`) the id to answer MISSING_METHOD with. */
function callOf(message: unknown): { id: unknown; method: string; params: Record<string, unknown> } | { invalid: unknown } {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return { invalid: null };
  const { id = null, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string") return { invalid: id };
  return { id, method, params: typeof params === "object" && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {} };
}

function matches(record: Terminal, labels: Record<string, string> | undefined): boolean {
  return Object.entries(labels ?? {}).every(([key, value]) => record.labels[key] === value);
}

function docName(params: { name?: unknown }): string {
  if (typeof params.name !== "string") throw missing("name");
  if (!NAME.test(params.name) || /^t\d+$/.test(params.name)) {
    throw new CallError(-32602, "invalid_params", `bad name "${params.name}": use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like an id (t7)`, "see `hc schema`");
  }
  return params.name;
}

function conflict(name: string, at: number, given: number): CallError {
  return new CallError(-32000, "conflict", `document "${name}" is at version ${at}, not ${given}`, "read doc.get and retry with its version");
}

function errorReply(id: unknown, error: CallError): unknown {
  return { error: { code: error.code, data: { hint: error.hint, kind: error.kind }, message: error.message }, id, jsonrpc: "2.0" };
}

function lineOf(message: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(message)}\n`);
}
