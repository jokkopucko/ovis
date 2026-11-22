import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";
import { ConnectionDiagnostics } from "./connection-diagnostics.ts";
import { INSERT_MAX_UNITS } from "../shared/terminal-insert.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-insert-"));
let server: { port: number; stop: () => void };
/** a bridge beside the first, on the same herdr: the pane's terminal is held by whichever attached first */
let other: { port: number; stop: () => void };
/** a bridge without terminal attach (no sidecar, as on Windows): panes are mirrored, typing goes through herdr */
let mirror: { port: number; stop: () => void };
const workspaces: string[] = [];

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
// bracketed paste on, as a shell's line editor has it; "off" says so explicitly, as a bare program would
process.stdout.write(process.argv[3] === "off" ? "\\u001b[?2004l" : "\\u001b[?2004h", () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

interface Chunk { at: number; data: string }
interface Recorder { pane: string; log: string }

const chunks = (recorder: Recorder): Chunk[] => readFileSync(recorder.log, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as Chunk]; } catch { return []; }
});
const typed = (recorder: Recorder, from: number) => chunks(recorder).slice(from).map((chunk) => chunk.data).join("");

/*
 * The recorder's files are looked at again until a deadline, not on fs.watch events: Bun can set a
 * directory watch up after watch() returns, so the write a wait was for could land unseen, and the
 * wait ran out with the text already in the log (#1948).
 */

async function appears(file: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (existsSync(file)) return;
    if (Date.now() > deadline) throw new Error(`${file} did not appear within ${ms}ms`);
    await Bun.sleep(25);
  }
}

async function recorded(recorder: Recorder, from: number, wanted: (text: string) => boolean, ms = 10_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = typed(recorder, from);
    if (wanted(text)) return text;
    if (Date.now() > deadline) throw new Error(`the recorder did not read text that ${wanted} holds of within ${ms}ms (${text.length} characters read): ${JSON.stringify(text)}`);
    await Bun.sleep(25);
  }
}

async function recorder(label: string, paste: "on" | "off" = "on"): Promise<Recorder> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-insert-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.jsonl`);
  const waited = appears(log);
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${process.execPath}' '${join(root, "record.js")}' '${log}' ${paste}\n` });
  await waited;
  return { pane: created.root_pane.pane_id, log };
}

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  private readonly subscribers = new Set<(message: Record<string, unknown>) => void>();
  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const message: Record<string, unknown> = JSON.parse(String((event as MessageEvent).data));
      this.seen.push(message);
      for (const subscriber of this.subscribers) subscriber(message);
    });
  }
  static async connect(port = server.port): Promise<Socket> {
    const socket = new Socket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    await socket.waitFor((message) => message.type === "snapshot");
    return socket;
  }
  async waitFor(predicate: (message: any) => boolean, ms = 15_000): Promise<any> {
    const found = this.seen.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.subscribers.delete(subscriber);
        reject(new Error(`frame not received within ${ms}ms`));
      }, ms);
      const subscriber = (message: Record<string, unknown>) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        this.subscribers.delete(subscriber);
        resolve(message);
      };
      this.subscribers.add(subscriber);
    });
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  result(id: number): Promise<any> {
    return this.waitFor((message) => message.type === "insert-result" && message.id === id);
  }
  answers(id: number): any[] {
    return this.seen.filter((message) => message.type === "insert-result" && message.id === id);
  }
  async attached(pane: string): Promise<number> {
    const mark = this.seen.length;
    this.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
    await this.waitFor((message) => this.seen.indexOf(message) >= mark && message.type === "input-ready" && message.pane_id === pane && message.ready !== false);
    return mark;
  }
  close(code?: number): void {
    this.ws.close(code);
  }
  async flushed(): Promise<void> {
    const ping = id();
    this.send({ type: "ping", id: ping });
    await this.waitFor((message) => message.type === "pong" && message.id === ping);
  }
}

const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
let nextId = 1;
const id = () => nextId++;

async function barrier(socket: Socket, recorder: Recorder, from: number, expected: string): Promise<void> {
  const marker = `barrier-${id()}`;
  const request = id();
  socket.send({ type: "insert", id: request, pane_id: recorder.pane, text: marker });
  expect(await socket.result(request)).toMatchObject({ ok: true });
  expect(await recorded(recorder, from, (text) => text.endsWith(marker))).toBe(expected + marker);
}

function mockScreen(paneId: string, screen: string | (() => string)) {
  const originalRead = herdr.paneRead;
  return spyOn(herdr, "paneRead").mockImplementation(async (options, socketPath) => {
    const result = await originalRead(options, socketPath);
    return options.paneId === paneId ? { ...result, text: typeof screen === "string" ? screen : screen() } : result;
  });
}

const ABNORMAL_CLOSE = 4000;
type Failed = ConnectionDiagnostics["failed"];

async function closedOnServer(socket: Socket, ms = 15_000): Promise<void> {
  const report = ConnectionDiagnostics.prototype.failed;
  let seen!: () => void;
  const reported = new Promise<void>((resolve) => { seen = resolve; });
  const spy = spyOn(ConnectionDiagnostics.prototype, "failed").mockImplementation(function (this: ConnectionDiagnostics, key: Parameters<Failed>[0], code: Parameters<Failed>[1], fields: Parameters<Failed>[2]) {
    report.call(this, key, code, fields);
    if (code === "closed" && fields.close_code === ABNORMAL_CLOSE) seen();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket.close(ABNORMAL_CLOSE);
    await Promise.race([reported, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the server did not handle the close within ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
    spy.mockRestore();
  }
}

let shell: Recorder;

beforeAll(async () => {
  writeFileSync(join(root, "record.js"), RECORDER);
  server = createServer({ port: 0, stateDir: join(root, "state") });
  other = createServer({ port: 0, stateDir: join(root, "state-other") });
  mirror = createServer({ port: 0, stateDir: join(root, "state-mirror"), terminalAttach: false });
  shell = await recorder("shell");
}, 30_000);

afterAll(async () => {
  server?.stop();
  other?.stop();
  mirror?.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  spyOn(herdr, "paneRead").mockRestore();
  spyOn(herdr, "paneSendText").mockRestore();
  spyOn(Date, "now").mockRestore();
});

describe("WebSocket insert", () => {
  it("is advertised, types the line at the prompt with no Enter, and answers once herdr holds the bytes", async () => {
    const socket = await Socket.connect();
    try {
      expect(socket.seen[0].features).toContain("terminal-insert");
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      const request = id();
      socket.send({ type: "insert", id: request, pane_id: shell.pane, text: "git status" });
      expect(await socket.result(request)).toEqual({ type: "insert-result", id: request, pane_id: shell.pane, ok: true });
      expect(await recorded(shell, from, (text) => text.includes("git status"))).toBe("git status");
      // a quote and non-ASCII go as typed; still no CR, LF, ESC or key after them
      await barrier(socket, shell, from, "git status");
      const after = chunks(shell).length;
      const second = id();
      socket.send({ type: "insert", id: second, pane_id: shell.pane, text: "echo '한글 😀'" });
      expect(await socket.result(second)).toMatchObject({ ok: true });
      expect(await recorded(shell, after, (text) => text.endsWith("😀'"))).toBe("echo '한글 😀'");
      expect(typed(shell, from)).not.toMatch(/[\r\n\u001b]/);
      expect(socket.answers(request)).toHaveLength(1);
    } finally { socket.close(); }
  }, 30_000);

  it("refuses every line break, bare or inside the client's paste markers, and types nothing of it", async () => {
    // herdr reports no paste mode of the program (its attach opens with its own ESC[?2004h), so even
    // a program that turned bracketed paste on takes no block from an Insert
    const socket = await Socket.connect();
    try {
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      for (const text of [paste("one\rtwo\rthree"), paste("one\ntwo"), "one\rtwo", "one\ntwo", "ls\r", "\n", `${paste("one")}\r`]) {
        const request = id();
        socket.send({ type: "insert", id: request, pane_id: shell.pane, text });
        expect(await socket.result(request)).toMatchObject({ ok: false, code: "unsafe_multiline" });
      }
      // a paste marker with no line break is an escape like any other
      const marked = id();
      socket.send({ type: "insert", id: marked, pane_id: shell.pane, text: `one${paste("two")}` });
      expect(await socket.result(marked)).toMatchObject({ ok: false, code: "invalid_insert_text" });
      // a tab would be taken by a shell as completion: refused like the other controls
      const tabbed = id();
      socket.send({ type: "insert", id: tabbed, pane_id: shell.pane, text: "git\tstatus" });
      expect(await socket.result(tabbed)).toMatchObject({ ok: false, code: "invalid_insert_text" });
      await barrier(socket, shell, from, "");
    } finally { socket.close(); }
  }, 30_000);

  it("refuses a block of lines, markers and all, where the program turned bracketed paste off", async () => {
    // the program said ESC[?2004l itself: the client's own paste markers do not make the block safe
    const bare = await recorder("paste-off", "off");
    const socket = await Socket.connect();
    try {
      await socket.attached(bare.pane);
      const from = chunks(bare).length;
      for (const [text, code] of [[paste("one\rtwo"), "unsafe_multiline"], [paste("one\ntwo"), "unsafe_multiline"], ["one\rtwo", "unsafe_multiline"], [paste("one"), "invalid_insert_text"]]) {
        const request = id();
        socket.send({ type: "insert", id: request, pane_id: bare.pane, text });
        expect(await socket.result(request)).toMatchObject({ ok: false, code });
      }
      await barrier(socket, bare, from, "");
      expect(typed(bare, from)).not.toMatch(/[\r\n\u001b]/);
    } finally { socket.close(); }
  }, 30_000);

  it("refuses malformed, empty, cut and oversized text before the pane is touched, and takes the longest line", async () => {
    const socket = await Socket.connect();
    try {
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      socket.send({ type: "insert", id: "one", pane_id: shell.pane, text: "x" });
      const badId = await socket.waitFor((message) => message.type === "error" && message.code === "invalid_insert");
      expect(badId.message).toContain("id");
      socket.send({ type: "insert", id: id(), text: "x" });
      await socket.waitFor((message) => message.type === "error" && message.code === "invalid_insert" && message !== badId);
      const refused: [unknown, string][] = [
        [undefined, "invalid_insert_text"], [42, "invalid_insert_text"], ["", "invalid_insert_text"], [paste(""), "invalid_insert_text"],
        ["a".repeat(INSERT_MAX_UNITS + 1), "insert_too_long"], [`abc${"😀".slice(0, 1)}`, "invalid_insert_text"], ["😀".slice(1), "invalid_insert_text"],
        ["a\u0003", "invalid_insert_text"], ["\u001b[A", "invalid_insert_text"], ["a\u007f", "invalid_insert_text"],
      ];
      for (const [text, code] of refused) {
        const request = id();
        socket.send({ type: "insert", id: request, pane_id: shell.pane, text });
        expect(await socket.result(request)).toMatchObject({ ok: false, code });
      }
      const longest = `${"b".repeat(INSERT_MAX_UNITS - 1)}c`;
      const request = id();
      socket.send({ type: "insert", id: request, pane_id: shell.pane, text: longest });
      expect(await socket.result(request)).toMatchObject({ ok: true });
      expect(await recorded(shell, from, (text) => text.endsWith("c"), 20_000)).toBe(longest);
      await barrier(socket, shell, from, longest);
    } finally { socket.close(); }
  }, 60_000);

  it("refuses an observing connection, a connection outside the attach, and a password prompt on screen", async () => {
    const socket = await Socket.connect();
    const outsider = await Socket.connect();
    try {
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack" && message.mode === "observe");
      const observing = id();
      socket.send({ type: "insert", id: observing, pane_id: shell.pane, text: "observed" });
      expect(await socket.result(observing)).toMatchObject({ ok: false, code: "read_only" });
      socket.send({ type: "role", mode: "interact" });
      await socket.waitFor((message) => message.type === "role-ack" && message.mode === "interact");
      // a connection that never attached the pane has no attach to type into
      const outside = id();
      outsider.send({ type: "insert", id: outside, pane_id: shell.pane, text: "outside" });
      expect(await outsider.result(outside)).toMatchObject({ ok: false, code: "not_attached" });
      // the live screen ends in a password prompt: pasted text is never typed into it
      const screen = mockScreen(shell.pane, "$ sudo ls\n[sudo] password for me:");
      const secret = id();
      socket.send({ type: "insert", id: secret, pane_id: shell.pane, text: "hunter2" });
      expect(await socket.result(secret)).toMatchObject({ ok: false, code: "secret_prompt" });
      screen.mockRestore();
      await barrier(socket, shell, from, "");
    } finally { socket.close(); outsider.close(); }
  }, 30_000);

  it("cancels at the write when the sender's role or attach went meanwhile, and a closed connection's insert is never replayed", async () => {
    const socket = await Socket.connect();
    try {
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      const original = herdr.paneSendText;
      const guards: (boolean | undefined)[] = [];
      // herdr's guard is asked right before the write: what happened to the sender meanwhile decides.
      const race = (change: () => Promise<void>) => spyOn(herdr, "paneSendText").mockImplementationOnce(async (pane, text, socketPath, guard) => {
        await change();
        guards.push(guard?.());
        return original(pane, text, socketPath, guard);
      });
      race(async () => {
        const mark = socket.seen.length;
        socket.send({ type: "role", mode: "observe" });
        await socket.waitFor((message) => socket.seen.indexOf(message) >= mark && message.type === "role-ack" && message.mode === "observe");
      });
      const roleLost = id();
      socket.send({ type: "insert", id: roleLost, pane_id: shell.pane, text: "role-lost" });
      expect(await socket.result(roleLost)).toMatchObject({ ok: false, code: "read_only" });
      socket.send({ type: "role", mode: "interact" });
      await socket.waitFor((message) => message.type === "role-ack" && message.mode === "interact");
      race(async () => {
        socket.send({ type: "detach", pane_id: shell.pane });
        await socket.flushed();
      });
      const detached = id();
      socket.send({ type: "insert", id: detached, pane_id: shell.pane, text: "detached" });
      expect(await socket.result(detached)).toMatchObject({ ok: false, code: "not_attached" });
      await socket.attached(shell.pane);
      // the connection closes while its insert waits on herdr: the guard refuses the write, and the
      // next connection's attach replays nothing of it
      race(() => closedOnServer(socket));
      socket.send({ type: "insert", id: id(), pane_id: shell.pane, text: "closed" });
      const next = await Socket.connect();
      try {
        await next.attached(shell.pane);
        await barrier(next, shell, from, "");
        expect(guards).toEqual([false, false, false]);
      } finally { next.close(); }
    } finally { socket.close(); }
  }, 30_000);

  it("refuses an insert that waited too long behind earlier input, typing nothing late", async () => {
    const socket = await Socket.connect();
    try {
      await socket.attached(shell.pane);
      const from = chunks(shell).length;
      let now = 1_800_000_000_000;
      spyOn(Date, "now").mockImplementation(() => now);
      const screen = mockScreen(shell.pane, () => { now += 46_000; return "$ "; });
      const late = id();
      socket.send({ type: "insert", id: late, pane_id: shell.pane, text: "late" });
      expect(await socket.result(late)).toMatchObject({ ok: false, code: "insert_timeout" });
      screen.mockRestore();
      spyOn(Date, "now").mockRestore();
      await barrier(socket, shell, from, "");
    } finally { socket.close(); }
  }, 30_000);

  it("refuses a pane whose terminal another web bridge holds", async () => {
    const held = await recorder("held");
    const first = await Socket.connect();
    const second = await Socket.connect(other.port);
    try {
      await first.attached(held.pane);
      const from = chunks(held).length;
      second.send({ type: "attach", pane_id: held.pane, cols: 80, rows: 24 });
      await second.waitFor((message) => message.type === "error" && message.code === "attach_held" && message.pane_id === held.pane);
      const request = id();
      second.send({ type: "insert", id: request, pane_id: held.pane, text: "held" });
      expect(await second.result(request)).toMatchObject({ ok: false, code: "attach_held" });
      await barrier(first, held, from, "");
    } finally { second.close(); first.close(); }
  }, 30_000);
});

describe("a herdr without terminal attach (Windows)", () => {
  it("types one line through herdr, and refuses several where an agent is as where none is", async () => {
    const mirrored = await recorder("mirror");
    const socket = await Socket.connect(mirror.port);
    try {
      await socket.attached(mirrored.pane);
      const from = chunks(mirrored).length;
      const line = id();
      socket.send({ type: "insert", id: line, pane_id: mirrored.pane, text: "mirror line" });
      expect(await socket.result(line)).toMatchObject({ ok: true });
      expect(await recorded(mirrored, from, (text) => text.includes("mirror line"))).toBe("mirror line");
      const bare = id();
      socket.send({ type: "insert", id: bare, pane_id: mirrored.pane, text: "one\rtwo" });
      expect(await socket.result(bare)).toMatchObject({ ok: false, code: "unsafe_multiline" });
      // an agent herdr names is no proof the program turned bracketed paste on: still refused, nothing shaped
      await herdrRpc("pane.report_agent", { pane_id: mirrored.pane, source: "manual", agent: "claude", state: "idle" });
      const agent = id();
      socket.send({ type: "insert", id: agent, pane_id: mirrored.pane, text: "one\rtwo" });
      expect(await socket.result(agent)).toMatchObject({ ok: false, code: "unsafe_multiline" });
      await barrier(socket, mirrored, from, "mirror line");
    } finally { socket.close(); }
  }, 30_000);
});
