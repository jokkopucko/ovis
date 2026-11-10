import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { PtySession } from "./pty/session.ts";
import { createServer } from "./index.ts";
import { herdrRpc, herdrSocketPath, paneRead, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";

interface ProxiedRequest { method: string; params: unknown; answered: boolean }
interface Leg { up: Socket<undefined> | null; held: Buffer[]; entry: ProxiedRequest | null }

/**
 * A unix socket in front of the test herdr, for what a mirrored pane is sent: herdr's own
 * socket cannot be asked what it received or made to refuse. One upstream connection per
 * client connection, bytes passed on as they come (a subscription stays open), each
 * request's method and params kept in order. `refuse` answers pane.send_text, and only
 * that, with a herdr error.
 */
function herdrProxy(path: string, upstream: string) {
  const log: ProxiedRequest[] = [];
  const control = { refuse: false, screens: null as { visible: string; detection: string } | null };
  // a write the kernel took only part of: the rest goes out on drain, and an end waits for it
  const backlog = new Map<object, { chunks: Buffer[]; end: boolean }>();
  const push = (to: Socket<any>, chunk: Buffer): void => {
    const waiting = backlog.get(to);
    if (waiting) { waiting.chunks.push(chunk); return; }
    const written = to.write(chunk);
    if (written < chunk.length) backlog.set(to, { chunks: [chunk.subarray(Math.max(written, 0))], end: false });
  };
  const end = (to: Socket<any>): void => {
    const waiting = backlog.get(to);
    if (waiting) waiting.end = true; else to.end();
  };
  const drain = (to: Socket<any>): void => {
    const waiting = backlog.get(to);
    if (!waiting) return;
    while (waiting.chunks.length) {
      const chunk = waiting.chunks[0]!;
      const written = to.write(chunk);
      if (written < chunk.length) { waiting.chunks[0] = chunk.subarray(Math.max(written, 0)); return; }
      waiting.chunks.shift();
    }
    backlog.delete(to);
    if (waiting.end) to.end();
  };
  const listener = Bun.listen<Leg>({
    unix: path,
    socket: {
      open(down) { down.data = { up: null, held: [], entry: null }; },
      data(down, chunk) {
        const leg = down.data;
        if (leg.up) { push(leg.up, Buffer.from(chunk)); return; }
        leg.held.push(Buffer.from(chunk));
        if (leg.entry) return;
        const head = Buffer.concat(leg.held);
        const newline = head.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(head.subarray(0, newline).toString()) as { id?: string; method: string; params: unknown };
        const entry: ProxiedRequest = { method: request.method, params: request.params, answered: false };
        leg.entry = entry;
        log.push(entry);
        // A scrolled viewport can show a previous prompt while the live screen has moved on.
        // Override only text reads: the mirror still draws the owned pane's real ANSI screen.
        const params = request.params as { source?: string; format?: string } | undefined;
        if (control.screens && request.method === "pane.read" && params?.format === "text") {
          const text = params.source === "detection" ? control.screens.detection : control.screens.visible;
          push(down, Buffer.from(`${JSON.stringify({ id: request.id, result: { read: { text } } })}\n`));
          entry.answered = true;
          end(down);
          return;
        }
        if (control.refuse && request.method === "pane.send_text") {
          push(down, Buffer.from(`${JSON.stringify({ id: request.id, error: { code: "proxy_refused", message: "refused by the test proxy" } })}\n`));
          entry.answered = true;
          end(down);
          return;
        }
        void Bun.connect<undefined>({
          unix: upstream,
          socket: {
            open(up) { leg.up = up; push(up, Buffer.concat(leg.held)); leg.held = []; },
            data(_up, answer) { if (answer.includes(10)) entry.answered = true; push(down, Buffer.from(answer)); },
            drain,
            close() { end(down); },
            error() { end(down); },
          },
        }).catch(() => end(down));
      },
      drain,
      close(down) { down.data.up?.end(); },
    },
  });
  return { log, control, stop: () => listener.stop(true) };
}

/** A no-echo stand-in: it records only a digest and byte count, never the entered value. */
function standIn(root: string): { script: string; resultFile: string } {
  const resultFile = join(root, "result.json");
  const script = join(root, "ask.cjs");
  writeFileSync(script, `
const { writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
process.stdin.setRawMode(true); process.stdin.resume();
let value = "";
process.stdout.write("\\x1b[2J\\x1b[HPassword:");
process.stdin.on("data", chunk => {
  value += chunk.toString();
  if (!value.includes("\\r")) return;
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ hash: createHash("sha256").update(value).digest("hex"), length: value.length }));
  value = ""; process.stdout.write("\\r\\nAccepted\\r\\nReady>");
});
`);
  return { script, resultFile };
}

/** One secret entered on a pane whose terminal is mirrored (a herdr that cannot attach), herdr behind the proxy. */
/** `value`: the secret sent. `typed`: as the page types it to a bridge that does not take the prompt, the value and then Enter as `input`. */
async function mirroredSecret(refuse: boolean, screens?: { visible: string; detection: string }, prompt = "Password:", value = "fixture-value", typed = false) {
  const root = mkdtempSync(join(tmpdir(), "ovis-secret-mirror-"));
  const { script, resultFile } = standIn(root);
  const herdr = herdrSocketPath();
  const proxy = herdrProxy(join(root, "herdr.sock"), herdr);
  // the server under test reaches herdr through the proxy; this test's own calls name herdr's socket
  process.env["HERDR_SOCKET"] = join(root, "herdr.sock");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  const seen: any[] = [];
  const sends = () => proxy.log.filter((entry) => entry.method === "pane.send_text" || entry.method === "pane.send_keys");
  /** the sends herdr had answered when the result reached the browser */
  let answeredAtResult: string[] | undefined;
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error("Secret contract deadline"); await Bun.sleep(25); }
  };
  try {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-secret-mirror", cwd: root, focus: false }, herdr,
    );
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`, herdr);
    await until(async () => (await paneRead({ paneId: pane, source: "visible", format: "text" }, herdr)).text.trim() === "Password:");
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "secret-result") answeredAtResult = sends().filter((entry) => entry.answered).map((entry) => entry.method);
      seen.push(frame);
    });
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    socket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
    await until(() => seen.some((frame) => frame.type === "pty-data"));
    proxy.control.refuse = refuse;
    proxy.control.screens = screens ?? null;
    const dispatchFrom = proxy.log.length;
    if (typed) {
      if (value) socket.send(JSON.stringify({ type: "input", pane_id: pane, text: value }));
      socket.send(JSON.stringify({ type: "input", pane_id: pane, text: "\r" }));
      await until(() => existsSync(resultFile));
    } else {
      socket.send(JSON.stringify({ type: "secret", id: 1, pane_id: pane, prompt, secret: value }));
      await until(() => seen.some((frame) => frame.type === "secret-result"));
    }
    const result = typed ? { ok: true } : seen.find((frame) => frame.type === "secret-result");
    // an unawaited send would still be on its way: let the pane have it before the log is read
    if (!refuse && result.ok) await until(() => existsSync(resultFile));
    const received = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
    const reads = proxy.log.slice(dispatchFrom).filter((entry) => entry.method === "pane.read" && (entry.params as { format?: string }).format === "text");
    return { result, received, pane, answeredAtResult, reads, sends: sends().map(({ method, params }) => ({ method, params })), frames: JSON.stringify(seen) };
  } finally {
    if (process.env["SECRET_PROXY_LOG"]) {
      writeFileSync(`${process.env["SECRET_PROXY_LOG"]}.${refuse ? "refused" : "accepted"}.json`, JSON.stringify({
        sends: sends(), answeredAtResult, results: seen.filter((frame) => frame.type === "secret-result"), methods: proxy.log.map((entry) => entry.method),
      }, null, 2));
    }
    socket?.close(); server.stop();
    process.env["HERDR_SOCKET"] = herdr;
    if (workspace) await workspaceClose(workspace, herdr);
    proxy.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

it("a secret on a mirrored pane is typed as text, entered with the Enter key, and answered once herdr took both", async () => {
  const { result, received, pane, answeredAtResult, sends, frames } = await mirroredSecret(false);
  expect(sends).toEqual([
    { method: "pane.send_text", params: { pane_id: pane, text: "fixture-value" } },
    { method: "pane.send_keys", params: { pane_id: pane, keys: ["Enter"] } },
  ]);
  expect(result.ok).toBe(true);
  expect(answeredAtResult).toEqual(["pane.send_text", "pane.send_keys"]);
  const expected = "fixture-value\r";
  expect(received).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
  expect(frames).not.toContain("fixture-value");
}, 15_000);

it("a secret herdr refused on a mirrored pane is answered as failed, with no Enter pressed", async () => {
  const { result, received, pane, sends, frames } = await mirroredSecret(true);
  expect({ ok: result.ok, code: result.code }).toEqual({ ok: false, code: "secret_failed" });
  expect(sends).toEqual([{ method: "pane.send_text", params: { pane_id: pane, text: "fixture-value" } }]);
  expect(received).toBeNull();
  expect(frames).not.toContain("fixture-value");
}, 15_000);

it("a secret is taken at a prompt of the wider set, which the snapshot says the server takes", async () => {
  for (const prompt of ["Password for 'https://alice@github.com':", "Enter passphrase for /home/alice/.ssh/id:work:"]) {
    const { result, received, sends, frames } = await mirroredSecret(false, { visible: prompt, detection: prompt }, prompt);
    expect(result.ok).toBe(true);
    expect(sends.map((entry) => entry.method)).toEqual(["pane.send_text", "pane.send_keys"]);
    const expected = "fixture-value\r";
    expect(received).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
    expect((JSON.parse(frames) as { type: string; features?: string[] }[]).find((frame) => frame.type === "snapshot")?.features).toContain("secret-prompts-2");
  }
}, 30_000);

it("no passphrase is entered with the Enter key alone where ssh-keygen offers it", async () => {
  const prompt = "Enter new passphrase (empty for no passphrase):";
  const { result, received, pane, sends } = await mirroredSecret(false, { visible: prompt, detection: prompt }, prompt, "");
  expect(result.ok).toBe(true);
  expect(sends).toEqual([{ method: "pane.send_keys", params: { pane_id: pane, keys: ["Enter"] } }]);
  expect(received).toEqual({ hash: createHash("sha256").update("\r").digest("hex"), length: 1 });
  // an empty value is no answer to a prompt that offers no such thing
  const refused = await mirroredSecret(false, undefined, "Password:", "");
  expect(refused.result).toMatchObject({ ok: false, code: "invalid_secret" });
  expect(refused.sends).toEqual([]);
}, 30_000);

it("a secret typed as the page types it to an older bridge is entered on a mirrored pane: the value, then Enter in its own frame", async () => {
  const { received, sends, pane } = await mirroredSecret(false, undefined, "Password:", "fixture-value", true);
  const expected = "fixture-value\r";
  expect(received).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
  expect(sends).toEqual([
    { method: "pane.send_text", params: { pane_id: pane, text: "fixture-value" } },
    { method: "pane.send_text", params: { pane_id: pane, text: "\r" } },
  ]);
}, 15_000);

it("a secret shown in scrollback is refused when the live screen is no longer asking for it", async () => {
  const { result, received, sends, reads } = await mirroredSecret(false, { visible: "Password:", detection: "Accepted\nReady>" });
  expect(result).toMatchObject({ ok: false, code: "prompt_changed" });
  expect(sends).toEqual([]);
  expect(received).toBeNull();
  expect(reads.map((entry) => (entry.params as { source: string }).source)).toEqual(["detection"]);
}, 15_000);

it("a secret's live prompt is validated even when the viewport is scrolled away from it", async () => {
  const { result, received, sends, reads } = await mirroredSecret(false, { visible: "Earlier output", detection: "Password:" });
  expect(result.ok).toBe(true);
  expect(sends.map((entry) => entry.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  const expected = "fixture-value\r";
  expect(received).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
  expect(reads.map((entry) => (entry.params as { source: string }).source)).toEqual(["detection"]);
}, 15_000);

it("secret frames validate prompts and authority, never queue, and type one no-echo line", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-secret-"));
  const { script, resultFile } = standIn(root);
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  const seen: any[] = [];
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error("Secret contract deadline"); await Bun.sleep(25); }
  };
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-secret" });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`);
    await until(async () => (await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trim() === "Password:");
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    expect(seen.find((frame) => frame.type === "snapshot").features).toContain("secret-input");
    const send = (frame: unknown) => socket!.send(JSON.stringify(frame));
    const secret = (id: number, extra = {}) => send({ type: "secret", id, pane_id: pane, prompt: "Password:", secret: "fixture-value", ...extra });
    const result = async (id: number) => {
      await until(() => seen.some((frame) => frame.type === "secret-result" && frame.id === id));
      return seen.find((frame) => frame.type === "secret-result" && frame.id === id);
    };
    secret(1);
    expect((await result(1)).code).toBe("not_attached");
    send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
    await until(() => seen.some((frame) => frame.type === "pty-data"));
    secret(2, { prompt: "Enter PIN:" });
    expect((await result(2)).code).toBe("prompt_changed");
    secret(3, { secret: "unsafe\ncommand" });
    expect((await result(3)).code).toBe("invalid_secret");
    send({ type: "role", mode: "observe" });
    secret(4);
    expect((await result(4)).code).toBe("read_only");
    expect(existsSync(resultFile)).toBe(false);
    send({ type: "role", mode: "interact" });
    // Authority can change while the screen check awaits herdr.
    secret(8); send({ type: "role", mode: "observe" });
    expect((await result(8)).code).toBe("read_only");
    expect(existsSync(resultFile)).toBe(false);
    send({ type: "role", mode: "interact" });
    // A second bridge is attached to the pane record but cannot write to the held PTY.
    const heldServer = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "held-state") });
    const heldSocket = new WebSocket(`ws://127.0.0.1:${heldServer.port}/ws`);
    const heldSeen: any[] = [];
    heldSocket.addEventListener("message", (event) => heldSeen.push(JSON.parse(String(event.data))));
    try {
      await until(() => heldSeen.some((frame) => frame.type === "snapshot"));
      heldSocket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
      await until(() => heldSeen.some((frame) => frame.code === "attach_held"));
      heldSocket.send(JSON.stringify({ type: "secret", id: 10, pane_id: pane, prompt: "Password:", secret: "fixture-value" }));
      await until(() => heldSeen.some((frame) => frame.type === "secret-result"));
      expect(heldSeen.find((frame) => frame.type === "secret-result")).toMatchObject({ ok: false, code: "input_not_ready" });
      expect(existsSync(resultFile)).toBe(false);
    } finally { heldSocket.close(); heldServer.stop(); }
    // A dead sidecar must not acknowledge bytes that it could not accept.
    const rejectedWrite = spyOn(PtySession.prototype, "write").mockReturnValue(false);
    try {
      secret(9);
      expect(await result(9)).toMatchObject({ ok: false, code: "input_not_ready" });
      expect(existsSync(resultFile)).toBe(false);
    } finally { rejectedWrite.mockRestore(); }
    // One prompt check is in flight: another secret must be refused, never held.
    secret(5); secret(6);
    expect((await result(6)).code).toBe("pane_busy");
    expect((await result(5)).ok).toBe(true);
    await until(() => existsSync(resultFile));
    const expected = "fixture-value\r";
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
    secret(7);
    expect((await result(7)).code).toBe("prompt_changed");
    expect(JSON.stringify(seen)).not.toContain("fixture-value");
    expect((await paneRead({ paneId: pane, source: "visible", format: "text" })).text).not.toContain("fixture-value");
  } finally {
    socket?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
