/**
 * One framed connection to herdr-core (`hc`), the runtime the Herdr desktop app runs its
 * terminals on. It goes through `hc connect`, which speaks hc's protocol over stdin/stdout and
 * resolves the core's endpoint the way every hc command does (HC_SESSION, HC_SOCKET, its config),
 * so this side never guesses a socket path.
 *
 * The protocol (herdr-core schema/README.md, generation 1): a `hello` line in plain JSON-RPC
 * switches the connection to framed mode, where every frame is
 * `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0 carries JSON-RPC both ways and its
 * calls run side by side; `terminal.attach` and `events.subscribe` answer with a channel of their
 * own, which carries the stream (raw terminal bytes, or one JSON-RPC notification per line).
 *
 * Calls are typed by hc's own schema (hc-api.generated.ts, `bun run generate:types`).
 */

import type { HcMethod, HcMethods } from "./hc-api.generated.ts";

/** The calls that answer with a stream of their own. */
export type HcStreamMethod = "terminal.attach" | "events.subscribe";

export const HC_GENERATION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
/** a `hc connect` that has not answered hello by then is not going to: the next call starts another */
const HELLO_TIMEOUT_MS = 10_000;
const HEADER_BYTES = 9;
/** hc's own ceiling for one frame's payload, and for the plain hello line before framing */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export const FRAME_DATA = 0;
export const FRAME_CREDIT = 1;
export const FRAME_CLOSE = 2;
export const FRAME_RESIZE = 3;
export const FRAME_FOCUS = 4;
export const FRAME_FACTS = 5;
/**
 * Reply bytes the viewer's terminal made itself (a query's answer), not anyone typing: hc passes
 * them to the program as DATA but does not count them as the viewer's activity. Only on a stream
 * both ends confirmed it for (`Channel.automaticInput`): a core that does not know the kind drops
 * the frame, and the bytes with it.
 */
export const FRAME_AUTOMATIC_INPUT = 6;
/** The hello feature a core names when it takes FRAME_AUTOMATIC_INPUT. */
export const AUTOMATIC_INPUT_FEATURE = "automatic_input";

export class HcError extends Error {
  /** hc's stable `data.kind` (`not_found`, `blocked`, `unavailable`, …), or this side's own */
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "HcError";
    this.kind = kind;
  }
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, channel, true);
  frame[4] = kind;
  view.setUint32(5, body.length, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}

export interface Frame { channel: number; kind: number; payload: Uint8Array }

/**
 * Splits a byte stream into frames; a frame split across reads waits for the rest. A length past
 * hc's ceiling cannot be a frame of this protocol: `onInvalid` hears it once and the reader stops.
 */
export function makeFrameReader(onFrame: (frame: Frame) => void, onInvalid: (reason: string) => void): (chunk: Uint8Array) => void {
  let pending = new Uint8Array(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    let buffer: Uint8Array;
    if (pending.length === 0) buffer = chunk;
    else {
      buffer = new Uint8Array(pending.length + chunk.length);
      buffer.set(pending);
      buffer.set(chunk, pending.length);
    }
    let offset = 0;
    while (buffer.length - offset >= HEADER_BYTES) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_BYTES);
      const length = view.getUint32(5, true);
      if (length > MAX_PAYLOAD_BYTES) {
        failed = true;
        onInvalid(`a ${length}-byte frame is over hc's ${MAX_PAYLOAD_BYTES}-byte limit`);
        return;
      }
      if (buffer.length - offset < HEADER_BYTES + length) break;
      const payload = buffer.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
      onFrame({ channel: view.getUint32(0, true), kind: buffer[offset + 4]!, payload });
      offset += HEADER_BYTES + length;
    }
    // the stdout pipe may reuse its buffer: keep a copy of the partial tail
    pending = buffer.slice(offset);
  };
}

export interface ChannelHandlers {
  onData: (payload: Uint8Array) => void;
  /** the stream is over: hc's JSON reason when it sent one, or this side's when the line went */
  onClose: (reason: Record<string, unknown> | null) => void;
  /** "manual": the owner credits what it consumed (`Channel.credit`), so it can hold a stream back */
  credit?: "auto" | "manual";
}

export interface Channel {
  readonly id: number;
  /**
   * Whether hc takes FRAME_AUTOMATIC_INPUT on this stream: its hello named the feature and its
   * attach answer confirmed it, as hc's protocol requires before a client may send the kind.
   */
  readonly automaticInput: boolean;
  write: (payload: Uint8Array | string) => void;
  /** Reply bytes the viewer's terminal made itself: FRAME_AUTOMATIC_INPUT where confirmed, else plain DATA as before. */
  writeAutomatic: (payload: Uint8Array | string) => void;
  /** the viewer's grid; hc takes it as the terminal's size, this being the last active viewer */
  resize: (cols: number, rows: number) => void;
  /** bytes of the stream consumed, for a channel opened with manual credit */
  credit: (bytes: number) => void;
  /** the viewer gained or lost focus: gaining it makes this viewer the active one */
  focus: (focused: boolean) => void;
  /** what the viewer's own terminal looks like (hc's `Display`: `fg`, `bg`, `cursor` as `#rrggbb`, `cell` in pixels) */
  facts: (display: Record<string, unknown>) => void;
  /** Detaches; settles once hc answered with its own CLOSE (what was written before has gone in) or the line ended. */
  close: () => Promise<void>;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** a call that answers with a stream registers it before anything reads the stream's first frame */
  channel?: ChannelHandlers;
}

interface OpenChannel {
  handlers: ChannelHandlers;
  /** this side sent CLOSE: hc's answering CLOSE settles it, and the stream's last bytes go unheard */
  closing?: () => void;
}

/** What spawns `hc connect`: tests hand in a fake core. */
export interface HcTransport {
  readable: ReadableStream<Uint8Array>;
  write: (bytes: Uint8Array) => void;
  exited: Promise<unknown>;
  kill: () => void;
}

/** `hc connect` as a child process; a program that cannot be started is an HcError (`closed`). */
export function spawnHcConnect(bin: string): HcTransport {
  // runtime.ts hands out this path that cannot exist while a moved hc is found again
  if (bin === "/dev/null/herdr-core-moved") throw new HcError("closed", "herdr-core moved (an update?), and Ovis is looking for it again: try again in a moment");
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    child = Bun.spawn([bin, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  } catch (error) {
    throw new HcError("closed", `hc could not be started (${bin}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    readable: child.stdout,
    write: (bytes) => {
      // a child that just exited takes no more: its end is reported through `exited`
      try {
        child.stdin.write(bytes);
        Promise.resolve(child.stdin.flush()).catch(() => {});
      } catch {
        /* the line ends on `exited` */
      }
    },
    exited: child.exited,
    kill: () => child.kill(),
  };
}

interface Line {
  transport: HcTransport;
  /** the hello answer: version and features of the core behind it */
  hello: Promise<HelloInfo>;
  pending: Map<number, PendingCall>;
  channels: Map<number, OpenChannel>;
  /** frames on a channel whose call has not been answered yet: hc may send a stream's first frames before its reply */
  early: Map<number, Frame[]>;
  /** channels this side gave up on (a late answer, an unanswered detach): their frames are dropped, not kept */
  abandoned: Set<number>;
  /** when hc last sent anything: a call that times out on a line silent since it was sent ends the line */
  heardAt: number;
  dead: boolean;
}

export interface HelloInfo { version: string; core: { id: string; name: string }; features: string[] }

/**
 * A lazily opened, self-replacing line to hc: the first call starts `hc connect`, and a line that
 * ended (hc restarted, `hc connect` died) fails what was waiting on it and is opened again by the
 * next call. Streams on it end with it; their owners open them again.
 */
export class HcConnection {
  private line: Line | null = null;
  private nextId = 1;
  private readonly spawn: () => HcTransport;

  constructor(spawn: () => HcTransport) {
    this.spawn = spawn;
  }

  /** The core's identity, from the hello of the current (or a fresh) line. */
  hello(): Promise<HelloInfo> {
    return this.current().hello;
  }

  call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HcMethods[M]["result"]> {
    return this.request<HcMethods[M]["result"]>(method, { ...params }, timeoutMs);
  }

  /**
   * A call that answers with a channel (`terminal.attach`, `events.subscribe`): `handlers` hear
   * the stream from its first frame on, and the returned channel writes to it.
   */
  async open<M extends HcStreamMethod>(method: M, params: HcMethods[M]["params"], handlers: ChannelHandlers, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ result: HcMethods[M]["result"]; channel: Channel }> {
    const line = this.current();
    const result = await this.request<HcMethods[M]["result"]>(method, { ...params }, timeoutMs, handlers, line);
    // framed mode always answers with a channel (only plain mode's subscribe has none)
    const id = result.channel as number;
    const live = () => !line.dead && line.channels.get(id)?.closing === undefined;
    // the request went out only after hello answered, so this awaits nothing
    const features = (await line.hello).features;
    const automaticInput = features.includes(AUTOMATIC_INPUT_FEATURE) && (result as { automatic_input?: unknown }).automatic_input === true;
    return {
      result,
      channel: {
        id,
        automaticInput,
        write: (payload) => {
          if (live()) line.transport.write(encodeFrame(id, FRAME_DATA, payload));
        },
        writeAutomatic: (payload) => {
          if (live()) line.transport.write(encodeFrame(id, automaticInput ? FRAME_AUTOMATIC_INPUT : FRAME_DATA, payload));
        },
        resize: (cols, rows) => {
          if (!live()) return;
          const grid = new Uint8Array(4);
          const view = new DataView(grid.buffer);
          view.setUint16(0, cols, true);
          view.setUint16(2, rows, true);
          line.transport.write(encodeFrame(id, FRAME_RESIZE, grid));
        },
        credit: (bytes) => {
          if (bytes > 0 && live()) line.transport.write(encodeFrame(id, FRAME_CREDIT, credit(bytes)));
        },
        focus: (focused) => {
          if (live()) line.transport.write(encodeFrame(id, FRAME_FOCUS, new Uint8Array([focused ? 1 : 0])));
        },
        facts: (display) => {
          if (live()) line.transport.write(encodeFrame(id, FRAME_FACTS, JSON.stringify(display)));
        },
        close: () => {
          const open = line.channels.get(id);
          if (line.dead || !open) return Promise.resolve();
          if (open.closing) {
            const { promise, resolve } = Promise.withResolvers<void>();
            const before = open.closing;
            open.closing = () => { before(); resolve(); };
            return promise;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          // a CLOSE hc never answers still lets the caller go: the channel is forgotten, as if answered
          const timer = setTimeout(() => {
            if (line.channels.get(id) !== open) return;
            line.channels.delete(id);
            line.abandoned.add(id);
            open.closing?.();
          }, DEFAULT_TIMEOUT_MS);
          open.closing = () => { clearTimeout(timer); resolve(); };
          line.transport.write(encodeFrame(id, FRAME_CLOSE, new Uint8Array(0)));
          return promise;
        },
      },
    };
  }

  close(): void {
    const line = this.line;
    this.line = null;
    if (line) this.end(line, "closed", "the hc connection was closed");
  }

  private async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number, channel?: ChannelHandlers, given?: Line): Promise<T> {
    const line = given ?? this.current();
    const id = this.nextId++;
    // when the request went out: a line silent since then is wedged
    let sentAt = Number.POSITIVE_INFINITY;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let waitingHello = true;
    const timer = setTimeout(() => {
      if (waitingHello) {
        this.end(line, "timeout", `hc hello timed out after ${timeoutMs}ms`);
        return;
      }
      line.pending.delete(id);
      reject(new HcError("timeout", `hc ${method} timed out after ${timeoutMs}ms`));
      // a slow answer (a send waiting for quiet) is no fault of the line; a line that said nothing since is wedged
      if (line.heardAt < sentAt) this.end(line, "timeout", "hc stopped answering");
    }, timeoutMs);
    line.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer, ...(channel ? { channel } : {}) });
    void line.hello.then(() => {
      waitingHello = false;
      if (line.dead || !line.pending.has(id)) return;
      sentAt = performance.now();
      line.transport.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    }).catch((error: unknown) => {
      line.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
    return promise;
  }

  private current(): Line {
    if (this.line && !this.line.dead) return this.line;
    const transport = this.spawn();
    const { promise: hello, resolve: helloDone, reject: helloFailed } = Promise.withResolvers<HelloInfo>();
    // a hello nobody awaited yet must not surface as an unhandled rejection
    hello.catch(() => {});
    const line: Line = { transport, hello, pending: new Map(), channels: new Map(), early: new Map(), abandoned: new Set(), heardAt: performance.now(), dead: false };
    this.line = line;
    const fail = (kind: string, message: string) => {
      helloFailed(new HcError(kind, message));
      this.end(line, kind, message);
    };
    const helloTimer = setTimeout(() => fail("timeout", `hc connect did not answer hello within ${HELLO_TIMEOUT_MS}ms`), HELLO_TIMEOUT_MS);
    void hello.then(() => clearTimeout(helloTimer), () => clearTimeout(helloTimer));
    const readFrame = makeFrameReader((frame) => this.onFrame(line, frame), (reason) => this.end(line, "bad_frame", `hc sent an invalid frame (${reason})`));
    void (async () => {
      const reader = transport.readable.getReader();
      const decoder = new TextDecoder();
      let plain = "";
      let framed = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          line.heardAt = performance.now();
          if (framed) { readFrame(value); continue; }
          // the hello's answer is the one plain line; every byte after its newline is framed
          const end = value.indexOf(0x0a);
          plain += decoder.decode(end === -1 ? value : value.subarray(0, end), { stream: end === -1 });
          if (plain.length > MAX_PAYLOAD_BYTES) { fail("bad_hello", "hc's hello answer is over its size limit"); return; }
          if (end === -1) continue;
          framed = true;
          const info = parseHello(plain);
          if (typeof info === "string") { fail("bad_hello", info); return; }
          helloDone(info);
          if (end + 1 < value.length) readFrame(value.subarray(end + 1));
        }
      } catch {
        /* the pipe broke: the line ends below */
      }
      fail("closed", "hc connect ended");
    })();
    void transport.exited.then(() => fail("closed", "hc connect ended"), () => {});
    transport.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: HC_GENERATION, framed: true } })}\n`));
    return line;
  }

  private onFrame(line: Line, frame: Frame): void {
    if (line.dead) return;
    if (frame.channel === 0) {
      if (frame.kind === FRAME_DATA) this.onMessage(line, frame.payload);
      return;
    }
    const open = line.channels.get(frame.channel);
    if (!open) {
      if (line.abandoned.has(frame.channel)) {
        if (frame.kind === FRAME_CLOSE) line.abandoned.delete(frame.channel);
        return;
      }
      // not ours yet: kept for the call whose answer names this channel (hc stops sending past its credit window)
      line.early.set(frame.channel, [...(line.early.get(frame.channel) ?? []), frame]);
      return;
    }
    if (frame.kind === FRAME_DATA) {
      // credit back what was taken: hc holds a stream at 256 KiB unacknowledged
      if (!open.closing) {
        if (open.handlers.credit !== "manual") line.transport.write(encodeFrame(frame.channel, FRAME_CREDIT, credit(frame.payload.length)));
        open.handlers.onData(frame.payload);
      }
    } else if (frame.kind === FRAME_CLOSE) {
      line.channels.delete(frame.channel);
      open.closing?.();
      open.handlers.onClose(parseReason(frame.payload));
    }
  }

  private onMessage(line: Line, payload: Uint8Array): void {
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      this.end(line, "bad_frame", "hc sent a message that is not JSON");
      return;
    }
    if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number") return;
    const call = line.pending.get(message.id);
    const answered = "result" in message && typeof message.result === "object" && message.result !== null && "channel" in message.result ? message.result.channel : undefined;
    if (!call) {
      // a stream whose call gave up waiting: nobody reads it, so hc is told to end it
      if (typeof answered === "number") {
        line.early.delete(answered);
        line.abandoned.add(answered);
        line.transport.write(encodeFrame(answered, FRAME_CLOSE, new Uint8Array(0)));
      }
      return;
    }
    line.pending.delete(message.id);
    clearTimeout(call.timer);
    if ("error" in message && typeof message.error === "object" && message.error !== null) {
      const error = message.error;
      const data = "data" in error && typeof error.data === "object" && error.data !== null ? error.data : null;
      const kind = data && "kind" in data && typeof data.kind === "string" ? data.kind : "error";
      call.reject(new HcError(kind, "message" in error && typeof error.message === "string" ? error.message : "hc refused the call"));
      return;
    }
    const result = "result" in message ? message.result : null;
    const channel = typeof result === "object" && result !== null && "channel" in result ? result.channel : undefined;
    if (call.channel && typeof channel === "number") {
      line.channels.set(channel, { handlers: call.channel });
      const early = line.early.get(channel) ?? [];
      line.early.delete(channel);
      for (const frame of early) this.onFrame(line, frame);
    }
    call.resolve(result);
  }

  private end(line: Line, kind: string, message: string): void {
    if (line.dead) return;
    line.dead = true;
    if (this.line === line) this.line = null;
    for (const call of line.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new HcError(kind, message));
    }
    line.pending.clear();
    line.early.clear();
    line.abandoned.clear();
    const channels = [...line.channels.values()];
    line.channels.clear();
    for (const open of channels) {
      open.closing?.();
      open.handlers.onClose({ reason: "connection_lost" });
    }
    try { line.transport.kill(); } catch { /* already gone */ }
  }
}

function credit(bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes, true);
  return payload;
}

function parseReason(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.length === 0) return null;
  try {
    const reason: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof reason === "object" && reason !== null && !Array.isArray(reason) ? reason as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The hello's answer, or why it is not one this side can speak to. */
export function parseHello(text: string): HelloInfo | string {
  let message: { result?: { generation?: unknown; framed?: unknown; version?: unknown; core?: { id?: unknown; name?: unknown }; features?: unknown }; error?: { message?: unknown } };
  try {
    message = JSON.parse(text);
  } catch {
    return "hc answered hello with something that is not JSON";
  }
  if (message.error) return `hc refused hello: ${typeof message.error.message === "string" ? message.error.message : "no reason given"}`;
  const result = message.result;
  if (result?.generation !== HC_GENERATION) return `hc speaks protocol generation ${String(result?.generation)}; Ovis speaks ${HC_GENERATION}`;
  if (result.framed !== true) return "hc did not switch the connection to framed mode";
  if (typeof result.version !== "string" || typeof result.core?.id !== "string" || typeof result.core.name !== "string") return "hc's hello is missing its version or core";
  const features = Array.isArray(result.features) ? result.features.filter((feature): feature is string => typeof feature === "string") : [];
  return { version: result.version, core: { id: result.core.id, name: result.core.name }, features };
}
