import { describe, expect, it } from "bun:test";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import { CoreAttachSession } from "./attach-session.ts";
import { encodeFrame, FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE, type Frame, HcConnection, type HcTransport, makeFrameReader } from "./connection.ts";

const CHANNEL = 7;
/** what the session asks the viewers' terminal on attach, as `hc attach` asks its own */
const ASKED = "\x1b[?1004h\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[16t\x1b[c";
const ASKED_AGAIN = ASKED.slice("\x1b[?1004h".length);
/** what goes ahead of hc's first bytes: the viewer's last attach's scrollback is erased, on the main screen, before hc replays it */
const CLEARED = "\x1b[?1049l\x1b[3J\x1b[H\x1b[2J";

class FakeCore implements HcTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly exited = Promise.withResolvers<unknown>().promise;
  readonly sent: Frame[] = [];
  attachParams: Record<string, unknown> | null = null;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private plain = true;
  private answered = Promise.withResolvers<void>();
  private waiters: (() => void)[] = [];
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame), () => {});
  private heldReply: (() => void) | null = null;

  /** `paintFirst`: the first paint goes out before the attach's reply, as hc's writer may send it. */
  constructor(private readonly options: { paintFirst?: string; holdReply?: boolean; answerClose?: boolean; features?: readonly string[]; confirmAutomatic?: boolean } = {}) {
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
  }

  get attached(): Promise<void> {
    return this.answered.promise;
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: { generation: 1, framed: true, version: "0.1.14", core: { id: "c1", name: "lab" }, features: this.options.features ?? ["framed", "attach"] } })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {}

  output(text: string): void {
    this.controller.enqueue(encodeFrame(CHANNEL, FRAME_DATA, text));
  }

  end(reason: Record<string, unknown>): void {
    this.controller.enqueue(encodeFrame(CHANNEL, FRAME_CLOSE, JSON.stringify(reason)));
  }

  until(kind: number, count: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => { if (this.of(kind).length >= count) { resolve(); return true; } return false; };
    if (!check()) this.waiters.push(() => { check(); });
    return promise;
  }

  of(kind: number): Frame[] {
    return this.sent.filter((frame) => frame.channel === CHANNEL && frame.kind === kind);
  }

  reply(): void {
    this.heldReply?.();
  }

  private onFrame(frame: Frame): void {
    if (frame.channel !== 0) {
      this.sent.push(frame);
      if (frame.kind === FRAME_CLOSE && this.options.answerClose !== false) this.controller.enqueue(encodeFrame(frame.channel, FRAME_CLOSE, new Uint8Array(0)));
      for (const waiter of this.waiters) waiter();
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(frame.payload)) as { id: number; method: string; params: Record<string, unknown> };
    if (message.method !== "terminal.attach") return;
    this.attachParams = message.params;
    if (this.options.paintFirst) this.output(this.options.paintFirst);
    const reply = () => {
      this.controller.enqueue(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { channel: CHANNEL, ...(this.options.confirmAutomatic ? { automatic_input: true } : {}) } })));
      queueMicrotask(() => this.answered.resolve());
    };
    if (this.options.holdReply) {
      this.heldReply = reply;
      this.controller.enqueue(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 1 } })));
    } else reply();
  }
}

function attach(onData: (data: string) => void = () => {}, options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const core = new FakeCore(options);
  const exits: (number | null)[] = [];
  const exited = Promise.withResolvers<void>();
  const session = new CoreAttachSession({
    hc: new HcConnection(() => core),
    terminal: "t3",
    cols: 80,
    rows: 24,
    onData,
    onExit: (code) => { exits.push(code); exited.resolve(); },
  });
  return { core, session, exits, exited: exited.promise };
}

/** An attached session whose program prints in hc frames: `program` resolves once the session has heard them all. */
async function attachedProgram() {
  const seen: string[] = [];
  // the attach's own questions come first, or they would land between the program's frames
  const next = { want: ASKED, hit: Promise.withResolvers<void>() };
  const attached = attach((data) => { seen.push(data); if (next.want && seen.join("").includes(next.want)) next.hit.resolve(); });
  await next.hit.promise;
  const program = async (...frames: string[]) => {
    next.want = frames.join("");
    next.hit = Promise.withResolvers<void>();
    for (const frame of frames) attached.core.output(frame);
    await next.hit.promise;
  };
  const typed = () => attached.core.of(FRAME_DATA).map((frame) => new TextDecoder().decode(frame.payload));
  return { ...attached, program, typed };
}

describe("CoreAttachSession", () => {
  it("attaches at the viewer's grid with its history, and types what was written before hc answered, in order", async () => {
    const { core, session } = attach();
    session.write("a");
    session.write("b");
    await core.until(FRAME_DATA, 2);
    expect(core.attachParams).toEqual({ terminal: "t3", cols: 80, rows: 24, history: TERMINAL_HISTORY_LINES });
    expect(core.of(FRAME_DATA).map((frame) => new TextDecoder().decode(frame.payload))).toEqual(["a", "b"]);
  });

  it("sends a resize, even one before hc answered, as hc's RESIZE frame, and nothing for winch", async () => {
    const { core, session } = attach();
    session.resize(100, 30);
    await core.until(FRAME_RESIZE, 1);
    // a same-size RESIZE would make this viewer hc's active one and take the size from whoever works there
    session.winch();
    session.write("x");
    await core.until(FRAME_DATA, 1);
    const grids = core.of(FRAME_RESIZE).map((frame) => {
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4);
      return [view.getUint16(0, true), view.getUint16(2, true)];
    });
    expect(grids).toEqual([[100, 30]]);
  });

  it("credits what it took, holds the credit while paused, and pays it on resume", async () => {
    const seen: string[] = [];
    const received = { count: 0, next: Promise.withResolvers<void>() };
    const { core, session } = attach((data) => { seen.push(data); received.count++; received.next.resolve(); });
    await core.attached;
    const credited = () => core.of(FRAME_CREDIT).map((frame) => new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true));
    const take = async (text: string) => {
      received.next = Promise.withResolvers<void>();
      core.output(text);
      await received.next.promise;
    };
    await take("hello");
    expect(credited()).toEqual([5]);
    session.pause();
    await take("held");
    expect(credited()).toEqual([5]);
    session.resume();
    expect(credited()).toEqual([5, 4]);
    expect(seen.join("").replace(ASKED, "")).toBe(`${CLEARED}helloheld`);
  });

  it("ends with the program's exit code when hc closes the stream", async () => {
    const { core, session, exits, exited } = attach();
    await core.attached;
    core.end({ reason: "exited", exit_code: 3, signal: null });
    await exited;
    expect(exits).toEqual([3]);
    expect(session.write("x")).toBe(false);
  });

  it("hears a first paint that hc sent before its reply to the attach, after erasing the viewer's scrollback once", async () => {
    const seen: string[] = [];
    const painted = Promise.withResolvers<void>();
    const { core } = attach((data) => { seen.push(data); painted.resolve(); }, { paintFirst: "first screen" });
    await core.attached;
    await painted.promise;
    expect(seen.join("")).toBe(`${CLEARED}first screen`);
    // and credits it, or hc would hold the stream at its window
    await core.until(FRAME_CREDIT, 1);
  });

  it("settles exited only once hc answered the detach, so a next attach cannot overlap it", async () => {
    const { core, session, exits } = attach(() => {}, { answerClose: false });
    await core.attached;
    session.write("x");
    await core.until(FRAME_DATA, 1);
    session.kill();
    await core.until(FRAME_CLOSE, 1);
    let settled = false;
    void session.exited.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(exits).toEqual([]);
    core.end({});
    await session.exited;
    expect(exits).toEqual([null]);
  });

  it("lets the stream go on kill, once, with no exit code, even when killed before hc answered", async () => {
    const { core, session, exits } = attach();
    session.kill();
    session.kill();
    await session.exited;
    expect(exits).toEqual([null]);
    await core.until(FRAME_CLOSE, 1);
    expect(core.of(FRAME_CLOSE)).toHaveLength(1);
    expect(session.write("x")).toBe(false);
  });

  it("asks the viewers' terminal what it looks like once attached, and tells hc what it answered", async () => {
    const seen: string[] = [];
    const asked = Promise.withResolvers<void>();
    const { core, session } = attach((data) => { seen.push(data); if (data.includes(ASKED)) asked.resolve(); });
    await asked.promise;
    // xterm's answers, then a typed key: the answers are hc's, the key the program's
    session.write("\x1b]10;rgb:eeee/eeee/eeee\x1b\\\x1b]11;rgb:1818/1818/1818\x07\x1b[6;17;9t\x1b[?62;22ca");
    await core.until(FRAME_DATA, 1);
    expect(core.of(FRAME_DATA).map((frame) => new TextDecoder().decode(frame.payload))).toEqual(["a"]);
    expect(core.of(FRAME_FACTS).map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)))).toEqual([{ fg: "#eeeeee", bg: "#181818", cell: [9, 17] }]);
    session.write("\x1b]11;rgb:1818/1818/1818\x07b");
    await core.until(FRAME_DATA, 2);
    expect(core.of(FRAME_FACTS)).toHaveLength(1);
  });

  it("turns focus reports into hc's FOCUS, asks again on focus, and keeps focus reports on", async () => {
    const seen: string[] = [];
    const next = { want: "", hit: Promise.withResolvers<void>() };
    const { core, session } = attach((data) => { seen.push(data); if (next.want && seen.join("").includes(next.want)) next.hit.resolve(); });
    next.want = ASKED;
    await next.hit.promise;
    session.write("\x1b[O\x1b[I");
    await core.until(FRAME_FOCUS, 2);
    expect(core.of(FRAME_FOCUS).map((frame) => frame.payload[0])).toEqual([0, 1]);
    expect(core.of(FRAME_DATA)).toHaveLength(0);
    expect(seen.join("").split(ASKED)).toHaveLength(2);
    expect(seen.join("").split(ASKED_AGAIN)).toHaveLength(3);
    next.want = "off\x1b[?1004l\x1b[?1004h";
    next.hit = Promise.withResolvers<void>();
    core.output("off\x1b[?1004l");
    await next.hit.promise;
    // re-enabling focus reports inline never splits an escape sequence cut across a 16 KiB frame boundary
    const marker = "\x1b[?9001l";
    for (let split = 1; split < marker.length; split++) {
      const start = seen.length;
      next.want = `END_${split}`;
      next.hit = Promise.withResolvers<void>();
      core.output(`\x18\x1b[!p\x1b[?1004lbody${marker.slice(0, split)}`);
      core.output(`${marker.slice(split)}END_${split}`);
      await next.hit.promise;
      expect(seen.slice(start).join("")).toContain(`${marker}END_${split}`);
    }
    session.kill();
  });

  it("types a lone cursor key in the cursor mode hc's stream last set, not the one the viewer's terminal still believed in", async () => {
    const { core, session, program, typed } = await attachedProgram();
    // application cursor keys, its sequence split across two of hc's frames: an arrow and Home typed as CSI reach it as SS3
    await program("less\x1b[?", "1h");
    session.write("\x1b[A");
    session.write("\x1b[H");
    // a subparameter 1 is mode 1004's, no DECCKM; a chord and a typed line are no lone cursor key
    await program("\x1b[?1004:1l");
    session.write("\x1b[B");
    session.write("\x1b[1;5A");
    session.write("\x1b[A\r");
    // back to normal mode: an arrow the viewer encoded as SS3 just before it heard reaches the program as CSI
    await program("\x1b[?1l$ ");
    session.write("\x1bOA");
    await core.until(FRAME_DATA, 6);
    expect(typed()).toEqual(["\x1bOA", "\x1bOH", "\x1bOB", "\x1b[1;5A", "\x1b[A\r", "\x1b[A"]);
    session.kill();
  });

  it("puts cursor keys back in normal mode on a terminal reset, and reads a mode list split anywhere or zero-padded", async () => {
    const { core, session, program, typed } = await attachedProgram();
    // `reset` after a program left application cursor keys on: RIS, then DECSTR
    await program("\x1b[?1h", "\x1bc$ ");
    session.write("\x1b[A");
    await program("\x1b[?1h", "\x1b[!p$ ");
    session.write("\x1b[H");
    // a mode list hc split far from its ESC, then one written with leading zeros
    await program("x\x1b[?1000;1006;1015;", "1", "h");
    session.write("\x1b[A");
    await program("\x1b[?0", "01l");
    session.write("\x1bOB");
    await program("\x1b[?01h");
    session.write("\x1b[F");
    await core.until(FRAME_DATA, 5);
    expect(typed()).toEqual(["\x1b[A", "\x1b[H", "\x1bOA", "\x1b[B", "\x1bOF"]);
    session.kill();
  });

  it("does not keep asking viewers whose terminal answers every focus-reports switch with a focus-in (#2815)", async () => {
    // two focused xterm.js tabs on the pane: each answers `ESC[?1004h` with ESC [ I
    const answers: string[] = [];
    const asked = Promise.withResolvers<void>();
    const { session } = attach((data) => {
      for (const _ of data.matchAll(/\x1b\[\?1004h/g)) answers.push("\x1b[I", "\x1b[I");
      if (data.includes(ASKED)) asked.resolve();
    });
    await asked.promise;
    let rounds = 0;
    while (answers.length > 0 && rounds < 10) {
      for (const answer of answers.splice(0)) session.write(answer);
      rounds++;
    }
    expect(answers).toEqual([]);
    expect(rounds).toBe(1);
    session.kill();
  });
});

describe("HcConnection streams", () => {
  it("tells hc to end a stream whose attach call already gave up waiting", async () => {
    const core = new FakeCore({ holdReply: true });
    const hc = new HcConnection(() => core);
    const opening = hc.open("terminal.attach", { terminal: "t3", cols: 80, rows: 24 }, { onData: () => {}, onClose: () => {} }, 50);
    await expect(opening).rejects.toMatchObject({ kind: "timeout" });
    core.reply();
    await core.until(FRAME_CLOSE, 1);
    expect(core.of(FRAME_CLOSE)).toHaveLength(1);
    hc.close();
  });
});

describe("CoreAttachSession, automatic input", () => {
  /** a cursor position report: an answer the program asked for, which reaches it (DA1 would answer the session's own question) */
  const REPLY = "\x1b[5;10R";
  const decode = (frames: Frame[]) => frames.map((frame) => new TextDecoder().decode(frame.payload));

  it("sends the viewer terminal's own replies as AUTOMATIC_INPUT once hello named it and the attach confirmed it", async () => {
    const { core, session } = attach(() => {}, { features: ["framed", "attach", "automatic_input"], confirmAutomatic: true });
    await core.attached;
    session.write(REPLY, true);
    session.write("ls\r");
    await core.until(FRAME_DATA, 1);
    await core.until(FRAME_AUTOMATIC_INPUT, 1);
    expect(decode(core.of(FRAME_AUTOMATIC_INPUT))).toEqual([REPLY]);
    expect(decode(core.of(FRAME_DATA))).toEqual(["ls\r"]);
    session.kill();
  });

  it("keeps a reply written before hc answered the attach automatic, in its place", async () => {
    const { core, session } = attach(() => {}, { features: ["automatic_input"], confirmAutomatic: true });
    session.write("a");
    session.write(REPLY, true);
    session.write("b");
    await core.until(FRAME_DATA, 2);
    await core.until(FRAME_AUTOMATIC_INPUT, 1);
    expect(core.sent.filter((frame) => frame.kind === FRAME_DATA || frame.kind === FRAME_AUTOMATIC_INPUT).map((frame) => [frame.kind, new TextDecoder().decode(frame.payload)]))
      .toEqual([[FRAME_DATA, "a"], [FRAME_AUTOMATIC_INPUT, REPLY], [FRAME_DATA, "b"]]);
    session.kill();
  });

  it("types text that is no terminal reply as DATA, even tagged automatic by the client", async () => {
    const { core, session } = attach(() => {}, { features: ["automatic_input"], confirmAutomatic: true });
    await core.attached;
    session.write("rm -rf ~/x\r", true);
    session.write("\x1b[A\r", true);
    await core.until(FRAME_DATA, 2);
    expect(decode(core.of(FRAME_DATA))).toEqual(["rm -rf ~/x\r", "\x1b[A\r"]);
    expect(core.of(FRAME_AUTOMATIC_INPUT)).toEqual([]);
    session.kill();
  });

  for (const [label, options] of [
    ["hello does not name it", { confirmAutomatic: true }],
    ["the attach does not confirm it", { features: ["automatic_input"] }],
  ] as const) {
    it(`types a reply as DATA, as before, when ${label}`, async () => {
      const { core, session } = attach(() => {}, options);
      await core.attached;
      session.write(REPLY, true);
      await core.until(FRAME_DATA, 1);
      expect(decode(core.of(FRAME_DATA))).toEqual([REPLY]);
      expect(core.of(FRAME_AUTOMATIC_INPUT)).toEqual([]);
      session.kill();
    });
  }
});
