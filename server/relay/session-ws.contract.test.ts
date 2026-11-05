import { afterEach, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { createCore } from "../core/index.ts";
import { handleRequest } from "../dispatch.ts";
import * as herdr from "../herdr/client.ts";
import { herdrRpc, paneRead, paneSendKeys, paneSendText } from "../herdr/client.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "../output-window.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";
import { VirtualSocket } from "./virtual-socket.ts";

type Link = Awaited<ReturnType<typeof relayConnection>>;
type CoreSocket = Parameters<ReturnType<typeof createCore>["socketHandlers"]["open"]>[0];
const fixtures: ReturnType<typeof relayFixture>[] = [];
const workspaces: string[] = [];
const restores: (() => void)[] = [];
function fixture(options: Parameters<typeof relayFixture>[1] = {}) {
  const value = relayFixture(false, { sidecar: true, ...options });
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const item of fixtures.splice(0)) item.close();
  for (const workspace of workspaces.splice(0)) await herdrRpc("workspace.close", { workspace_id: workspace });
});

async function pane(f: ReturnType<typeof fixture>, animate = false) {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-relay-ws", cwd: f.stateDir, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const id = created.root_pane.pane_id;
  if (animate) {
    // A paced real terminal animation, not a test synchronization delay. Start before attaching:
    // herdr's attach-time terminal queries must never swallow the program's initial keystrokes.
    await paneSendText(id, `python3 -u -c 'import sys,time,itertools
for i in itertools.count(): sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23); sys.stdout.flush(); time.sleep(.01)'`);
    await paneSendKeys(id, ["Enter"]);
  }
  return id;
}

async function connection(f: ReturnType<typeof fixture>, role: "drive" | "watch" = "drive",
  options: Parameters<typeof relayConnection>[1] = {}) {
  const device = await relayDevice(f, role);
  const link = await relayConnection(f, { websocket: f.app.context.services.core.socketHandlers, ...options });
  await link.auth(device);
  return { link, device };
}

async function attach(link: Link, paneId: string, ack = true) {
  const socket = link.openSocket();
  let bytes = 0;
  let frames = 0;
  let last: Extract<ServerMessage, { type: "pty-data" }> | undefined;
  socket.listeners.add((message) => {
    if (message.type !== "pty-data" || message.pane_id !== paneId) return;
    bytes += Buffer.byteLength(message.data);
    frames++;
    last = message;
    if (ack && message.flow) socket.send({ type: "pty-ack", pane_id: paneId, ...message.flow });
  });
  await socket.opened;
  socket.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
  await socket.until((message) => message.type === "pty-data" && message.pane_id === paneId);
  return { socket, get bytes() { return bytes; }, get frames() { return frames; }, get last() { return last; } };
}

/** Holds the core's next guarded key write before herdr is written to: the key is in flight, not yet typed. */
function holdKeyWrite() {
  const entered = deferred<void>();
  const release = deferred<void>();
  const settled = deferred<void>();
  const send = herdr.paneSendKeys;
  const held = spyOn(herdr, "paneSendKeys").mockImplementation(async (paneId, keys, socketPath, guard) => {
    if (!guard) return send(paneId, keys, socketPath);
    entered.resolve();
    await release.promise;
    try { return await send(paneId, keys, socketPath, guard); }
    finally { settled.resolve(); }
  });
  restores.push(() => { release.resolve(); held.mockRestore(); });
  return {
    entered: bounded(entered.promise),
    /** lets the key go on to herdr, which asks its guard first; resolves once that write is done or refused */
    release() { release.resolve(); return bounded(settled.promise); },
    restore() { held.mockRestore(); },
  };
}

/** Resolves once the pane's output from now on shows `text`. */
function printed(socket: Awaited<ReturnType<typeof attach>>["socket"], paneId: string, text: string) {
  let output = "";
  const shown = deferred<void>();
  socket.listeners.add((message) => {
    if (message.type === "pty-data" && message.pane_id === paneId && (output += message.data).includes(text)) shown.resolve();
  });
  return bounded(shown.promise);
}

/** Clears the shell line, runs a marker through herdr and returns the pane's text once the marker printed. */
async function textAfterMarker(socket: Awaited<ReturnType<typeof attach>>["socket"], paneId: string) {
  const done = printed(socket, paneId, "DONE");
  // ^U: the shell drops whatever is left on its line
  await paneSendText(paneId, "\u0015printf 'D%sE\\n' ON");
  await paneSendKeys(paneId, ["Enter"]);
  await done;
  return (await paneRead({ paneId, source: "recent" })).text;
}

it("terminal queue isolation over relay", async () => {
  const f = fixture();
  const paneId = await pane(f, true);
  const core = f.app.context.services.core;
  let serverSocket: CoreSocket | undefined;
  const open = core.socketHandlers.open;
  const opened = spyOn(core.socketHandlers, "open").mockImplementation((socket) => {
    serverSocket = socket;
    return open(socket);
  });
  restores.push(() => opened.mockRestore());
  const chunk = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const total = 40 * 1024 * 1024;
  const { link } = await connection(f, "drive", {
    dispatch: (request, context) => {
      if (new URL(request.url).pathname !== "/api/download") return handleRequest(request, context);
      let remaining = total;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!remaining) { controller.close(); return; }
          controller.enqueue(chunk);
          remaining -= chunk.length;
        },
      }, { highWaterMark: 0 }), { headers: { "content-length": String(total) } }));
    },
  });
  const terminal = await attach(link, paneId);
  const download = await link.open("/api/download").response;
  await terminal.socket.until(() => terminal.bytes >= OUTPUT_HIGH_BYTES * 2);
  if (!serverSocket) throw new Error("Missing virtual socket");
  await link.flush();
  // The unread HTTP response still holds source/queue bytes. Terminal receipts have their
  // own budget: charging those HTTP bytes here fails even before the hard-limit close.
  expect(link.session.bufferedBytes).toBeGreaterThan(OUTPUT_HARD_BYTES);
  expect(serverSocket.getBufferedAmount()).toBe(0);
  expect(link.session.mux.stats.queuedBytes).toBeGreaterThan(0);
  const before = terminal.bytes;
  const digest = createHash("sha256");
  const reader = download.body?.getReader();
  if (!reader) throw new Error("Missing download");
  let received = 0;
  try {
    for (;;) {
      const result = await bounded(reader.read());
      if (result.done) break;
      received += result.value.length;
      digest.update(result.value);
    }
  } finally { reader.releaseLock(); }
  await terminal.socket.until(() => terminal.bytes > before + 4096);
  await link.flush();
  const expected = createHash("sha256");
  for (let offset = 0; offset < total; offset += chunk.length) expected.update(chunk);
  expect(received).toBe(total);
  expect(digest.digest("hex")).toBe(expected.digest("hex"));
  expect(link.frames.filter((frame) => frame.type === FrameType.WS_CLOSE)).toHaveLength(0);
  expect(link.channel.isOpen()).toBe(true);
  console.log(`ISOLATION download=${received} terminal_bytes=${terminal.bytes} frames=${terminal.frames} buffered=${serverSocket.getBufferedAmount()} WS_CLOSE=0 channel_open=${link.channel.isOpen()}`);
}, 30_000);

it("closes exactly one stalled terminal with 4008 while HTTP and the channel survive", async () => {
  const f = fixture();
  const paneId = await pane(f, true);
  const { link } = await connection(f);
  const terminal = await attach(link, paneId, false);
  const closes: { code: number | null; abort: boolean }[] = [];
  link.onFrame = (frame) => {
    if (frame.type === FrameType.WS_CLOSE && frame.stream_id === terminal.socket.stream.id) closes.push(frame.payload);
  };
  await terminal.socket.until(() => terminal.bytes >= OUTPUT_HIGH_BYTES);
  const blockedAt = performance.now();
  expect((await link.open("/api/health").response).status).toBe(200);
  const close = await bounded(terminal.socket.closed, OUTPUT_STALL_MS + 3000);
  const elapsed = performance.now() - blockedAt;
  expect(close.code).toBe(4008);
  expect(elapsed).toBeLessThan(OUTPUT_STALL_MS + 2000);
  expect(terminal.bytes).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
  expect(closes).toEqual([expect.objectContaining({ code: 4008, abort: true })]);
  expect((await link.open("/api/health").response).status).toBe(200);
  expect(link.channel.isOpen()).toBe(true);
  console.log(`STALL bytes=${terminal.bytes} close_count=${closes.length} code=${close.code} abort=${closes[0]?.abort} elapsed_ms=${Math.round(elapsed)} HTTP=200 channel_open=${link.channel.isOpen()}`);
}, 20_000);

it("revokes an attached websocket with 1008 before ending the encrypted session", async () => {
  const f = fixture();
  const { link, device } = await connection(f);
  const terminal = await attach(link, await pane(f));
  f.app.context.services.devices.revoke(device.id);
  expect((await bounded(terminal.socket.closed)).code).toBe(1008);
  expect(await bounded(link.serverError)).toBe("auth_revoked");
  await bounded(link.closed);
  expect(link.frames.filter((frame) => frame.type === FrameType.WS_CLOSE)).toHaveLength(1);
});

it("downgrades an attached driver by closing stale authority and readmitting as watch", async () => {
  const f = fixture();
  const { link, device } = await connection(f);
  const paneId = await pane(f);
  const terminal = await attach(link, paneId);
  f.app.context.services.devices.update(device.id, { role: "watch" });
  expect((await bounded(terminal.socket.closed)).code).toBe(1008);
  expect(await bounded(link.serverError)).toBe("auth_changed");
  await bounded(link.closed);
  const next = await relayConnection(f, { websocket: f.app.context.services.core.socketHandlers });
  expect((await next.auth(device)).role).toBe("watch");
  const watched = await attach(next, paneId);
  watched.socket.send({ type: "role", mode: "interact" });
  expect(await watched.socket.until((message) => message.type === "role-ack")).toMatchObject({ mode: "observe" });
  watched.socket.send({ type: "input", pane_id: paneId, text: "forbidden\r" });
  expect(await watched.socket.until((message) => message.type === "error")).toMatchObject({ code: "read_only" });
  f.app.context.services.devices.revoke(device.id);
  expect((await bounded(watched.socket.closed)).code).toBe(1008);
  expect(await bounded(next.serverError)).toBe("auth_revoked");
});

it("refuses a watch device's input and elevation as on direct sockets", async () => {
  const f = fixture();
  const { link } = await connection(f, "watch");
  const terminal = await attach(link, await pane(f));
  terminal.socket.send({ type: "role", mode: "interact" });
  expect(await terminal.socket.until((message) => message.type === "role-ack")).toMatchObject({ mode: "observe" });
  terminal.socket.send({ type: "input", pane_id: terminal.last?.pane_id ?? "", text: "forbidden\r" });
  expect(await terminal.socket.until((message) => message.type === "error")).toMatchObject({ code: "read_only" });
});

it("drops a key not yet typed when the phone closes the socket, as a native socket does", async () => {
  const f = fixture();
  const { link } = await connection(f);
  const paneId = await pane(f);
  const terminal = await attach(link, paneId);
  const key = holdKeyWrite();
  // the command line reaches the shell: only its Enter is in question
  const echoed = printed(terminal.socket, paneId, "ELAY_MAR");
  terminal.socket.send({ type: "input", pane_id: paneId, text: "printf 'R%sK\\n' ELAY_MAR" });
  terminal.socket.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
  await key.entered;
  await echoed;
  terminal.socket.stream.close(1000);
  expect((await bounded(terminal.socket.closed)).code).toBe(1000);
  await link.flush();
  await key.release();
  key.restore();
  const probe = await attach(link, paneId);
  expect(await textAfterMarker(probe.socket, paneId)).not.toContain("RELAY_MARK");
});

it("refuses a key not yet typed once observe is asked, as a native socket does", async () => {
  const f = fixture();
  const { link } = await connection(f);
  const paneId = await pane(f);
  const terminal = await attach(link, paneId);
  const key = holdKeyWrite();
  // the command line reaches the shell: only its Enter is in question
  const echoed = printed(terminal.socket, paneId, "ELAY_MAR");
  terminal.socket.send({ type: "input", pane_id: paneId, text: "printf 'R%sK\\n' ELAY_MAR" });
  terminal.socket.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
  await key.entered;
  await echoed;
  terminal.socket.send({ type: "role", mode: "observe" });
  await link.flush();
  await key.release();
  key.restore();
  expect(await terminal.socket.until((message) => message.type === "role-ack")).toMatchObject({ mode: "observe" });
  expect(await textAfterMarker(terminal.socket, paneId)).not.toContain("RELAY_MARK");
  expect(await terminal.socket.until((message) => message.type === "error")).toMatchObject({ code: "input_failed", pane_id: paneId });
});

it("routes machine_id through MachineRelay and resets upstream loss", async () => {
  const f = fixture();
  const manager = f.app.context.services.core.machines;
  if (!manager) throw new Error("Missing machines");
  const received = deferred<ClientMessage>();
  const remoteSocket = deferred<ServerWebSocket<undefined>>();
  const remote = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(socket) { remoteSocket.resolve(socket); socket.send(JSON.stringify({ type: "pty-data", pane_id: "remote-pane", data: "REMOTE" })); },
      message(socket, raw) {
        const message: ClientMessage = JSON.parse(String(raw));
        received.resolve(message);
        socket.send(JSON.stringify({ type: "pong", id: 91 }));
      },
    },
  });
  const endpoint = spyOn(manager, "endpoint").mockImplementation(() => ({ url: `http://127.0.0.1:${remote.port}`, token: "test" }));
  const tracked = spyOn(manager, "trackTerminal").mockImplementation(() => () => {});
  try {
    const { link } = await connection(f);
    const socket = link.openSocket("/ws?machine_id=remote");
    await socket.opened;
    expect(await socket.until((message) => message.type === "pty-data")).toMatchObject({ data: "REMOTE" });
    socket.send({ type: "attach", pane_id: "remote-pane", cols: 80, rows: 24, flow_control: "ack", receipt_resume_id: "12345678-1234-4234-8234-123456789abc" });
    expect(await bounded(received.promise)).toEqual({ type: "attach", pane_id: "remote-pane", cols: 80, rows: 24, flow_control: "ack" });
    await socket.until((message) => message.type === "pong");
    const reset = deferred<string>();
    link.onFrame = (frame) => { if (frame.type === FrameType.RESET) reset.resolve(frame.payload.code); };
    (await bounded(remoteSocket.promise)).close(1001, "gone");
    expect(await bounded(reset.promise)).toBe("upstream_lost");
    expect((await bounded(socket.closed)).code).toBe(1006);
    expect((await link.open("/api/health").response).status).toBe(200);
  } finally { endpoint.mockRestore(); tracked.mockRestore(); remote.stop(true); }
});

it("drops queued frames on repeated carrier loss without resending them", async () => {
  const f = fixture();
  const device = await relayDevice(f);
  for (let attempt = 0; attempt < 3; attempt++) {
    const link = await relayConnection(f, { websocket: f.app.context.services.core.socketHandlers });
    await link.auth(device);
    const socket = link.openSocket();
    await socket.opened;
    // Same turn: the mux has accepted the frame but its microtask sender has not submitted it.
    socket.send({ type: "ping", id: 700 + attempt });
    expect(socket.stream.queuedBytes).toBeGreaterThan(0);
    link.stop();
    expect((await bounded(socket.closed)).code).toBe(1006);
    expect(socket.stream.getBufferedAmount()).toBe(0);
    expect(socket.messages.some((message) => message.type === "pong")).toBe(false);
  }
  const fresh = await relayConnection(f, { websocket: f.app.context.services.core.socketHandlers });
  await fresh.auth(device);
  const socket = fresh.openSocket();
  await socket.opened;
  socket.send({ type: "ping", id: 999 });
  await socket.until((message) => message.type === "pong");
  expect(socket.messages.filter((message) => message.type === "pong")).toEqual([{ type: "pong", id: 999 }]);
});

for (const revoke of [false, true]) {
  it(`${revoke ? "revoke" : "carrier loss"} during attach invalidates the last client claim`, async () => {
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const f = fixture({ terminalAttach: () => { entered.resolve(); return release.promise; } });
    const { link, device } = await connection(f);
    const socket = link.openSocket();
    await socket.opened;
    const core = f.app.context.services.core;
    const handled = deferred<CoreSocket>();
    const message = core.socketHandlers.message;
    const tracked = spyOn(core.socketHandlers, "message").mockImplementation(async (client, raw) => {
      await message(client, raw);
      handled.resolve(client);
    });
    try {
      const paneId = await pane(f);
      socket.send({ type: "attach", pane_id: paneId, cols: 80, rows: 24, flow_control: "ack" });
      await bounded(entered.promise);
      if (revoke) f.app.context.services.devices.revoke(device.id);
      else link.stop();
      expect((await bounded(socket.closed)).code).toBe(revoke ? 1008 : 1006);
      release.resolve(true);
      const client = await bounded(handled.promise);
      expect(client.data.attached.size).toBe(0);
      expect(client.data.output.size).toBe(0);
      expect(client.readyState).toBe(WebSocket.CLOSED);
      const fresh = await connection(f);
      const replacement = await attach(fresh.link, paneId);
      expect(replacement.bytes).toBeGreaterThan(0);
      expect(replacement.socket.messages.some((frame) => frame.type === "error")).toBe(false);
    } finally { release.resolve(true); tracked.mockRestore(); }
  });
}

it("counts only serialized stream bytes, drains on receipts, and closes overflow once", async () => {
  const f = fixture();
  const made = deferred<VirtualSocket>();
  const drained = deferred<void>();
  let drains = 0;
  let closes = 0;
  const { link } = await connection(f, "drive", {
    websocket: {
      open(socket) {
        if (!(socket instanceof VirtualSocket)) throw new Error("Missing virtual socket");
        made.resolve(socket);
      },
      message() {},
      close() { closes++; },
      drain() { drains++; drained.resolve(); },
    },
  });
  const ws = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const accepted = deferred<void>();
  ws.onAccept = () => accepted.resolve();
  const received: string[] = [];
  ws.onMessage = (raw) => { received.push(String(raw)); };
  await bounded(accepted.promise);
  const socket = await bounded(made.promise);
  const text = "한".repeat(30_000);
  expect(socket.send(text)).toBe(-1);
  expect(socket.getBufferedAmount()).toBe(Buffer.byteLength(text));
  await bounded(drained.promise);
  await link.flush();
  expect(drains).toBe(1);
  expect(received).toEqual([text]);
  socket.send("x".repeat(OUTPUT_HARD_BYTES));
  expect(socket.send("x")).toBe(0);
  socket.close(4008);
  expect(closes).toBe(1);
  await link.session.mux.flush();
  expect(link.frames.filter((frame) => frame.type === FrameType.WS_CLOSE)).toHaveLength(1);
});

it("keeps RECEIVED transport accounting distinct from CREDIT while a WS sink is held", async () => {
  const f = fixture();
  const made = deferred<VirtualSocket>();
  const { link } = await connection(f, "drive", {
    websocket: {
      open(socket) {
        if (!(socket instanceof VirtualSocket)) throw new Error("Missing virtual socket");
        made.resolve(socket);
      },
      message() {}, close() {}, drain() {},
    },
  });
  const stream = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const entered = deferred<void>();
  const release = deferred<void>();
  stream.onMessage = () => { entered.resolve(); return release.promise; };
  const socket = await bounded(made.promise);
  try {
    expect(socket.send("x".repeat(OUTPUT_LOW_BYTES))).toBe(-1);
    await bounded(entered.promise);
    await link.flush();
    expect(socket.getBufferedAmount()).toBe(0);
    expect(stream.received).toBe(BigInt(OUTPUT_LOW_BYTES));
    expect(stream.consumed).toBe(0n);
    expect(link.session.mux.stats.acknowledged).toBe(link.session.mux.stats.submitted);
  } finally { release.resolve(); }
});

it("drains accepted messages before a normal close without replay or duplicate close", async () => {
  const f = fixture();
  const made = deferred<VirtualSocket>();
  let detached = 0;
  const { link } = await connection(f, "drive", {
    websocket: {
      open(socket) {
        if (!(socket instanceof VirtualSocket)) throw new Error("Missing virtual socket");
        made.resolve(socket);
      },
      message() {}, close() { detached++; }, drain() {},
    },
  });
  const stream = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const messages: string[] = [];
  const closed = deferred<number>();
  stream.onMessage = (raw) => { messages.push(String(raw)); };
  stream.onClose = (event) => closed.resolve(event.code);
  const socket = await bounded(made.promise);
  expect(socket.send("first")).toBe(-1);
  expect(socket.send("last")).toBe(-1);
  socket.close(1000, "done");
  expect(socket.readyState).toBe(WebSocket.CLOSING);
  expect(detached).toBe(1);
  expect(socket.send("too late")).toBe(0);
  expect(await bounded(closed.promise)).toBe(1000);
  expect(messages).toEqual(["first", "last"]);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(detached).toBe(1);
  expect(link.frames.filter((frame) => frame.type === FrameType.WS_CLOSE)).toHaveLength(1);
});

it("ends the connection at the peer's close even while this side's close waits behind output", async () => {
  const f = fixture();
  const made = deferred<VirtualSocket>();
  const detached: number[] = [];
  const { link } = await connection(f, "drive", {
    websocket: {
      open(socket) {
        if (!(socket instanceof VirtualSocket)) throw new Error("Missing virtual socket");
        made.resolve(socket);
      },
      message() {}, close(_socket, code) { detached.push(code); }, drain() {},
    },
  });
  const stream = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const release = deferred<void>();
  // the phone has not read the output yet: no CREDIT, so the server's own CLOSE waits behind it
  stream.onMessage = () => release.promise;
  const socket = await bounded(made.promise);
  try {
    socket.send("x".repeat(700 * 1024));
    await link.flush();
    socket.send("x".repeat(600 * 1024));
    await link.flush();
    expect(socket.getBufferedAmount()).toBeGreaterThan(0);
    stream.close(1000);
    await link.flush();
    // a native socket's close handler runs as the close arrives: input still queued goes nowhere
    expect(detached).toEqual([1000]);
    expect(socket.readyState).toBe(WebSocket.CLOSING);
  } finally { release.resolve(); }
});

it("delivers revocation's 1008 even when graceful draining exhausts its budget", async () => {
  const f = fixture();
  const clock = new TestClock();
  const made = deferred<VirtualSocket>();
  const { link, device } = await connection(f, "drive", {
    clock,
    websocket: {
      open(socket) {
        if (!(socket instanceof VirtualSocket)) throw new Error("Missing virtual socket");
        made.resolve(socket);
      },
      message() {}, close() {}, drain() {},
    },
  });
  const stream = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const release = deferred<void>();
  stream.onMessage = () => release.promise;
  const close = deferred<number>();
  stream.onClose = (event) => close.resolve(event.code);
  const socket = await bounded(made.promise);
  try {
    socket.send("x".repeat(700 * 1024));
    await link.flush();
    expect(socket.getBufferedAmount()).toBe(0); // RECEIVED arrived, CREDIT did not.
    socket.send("x".repeat(600 * 1024));
    await link.flush();
    expect(socket.getBufferedAmount()).toBeGreaterThan(0);
    f.app.context.services.devices.revoke(device.id);
    await link.flush();
    expect(socket.readyState).toBe(WebSocket.CLOSING);
    clock.advance(5000);
    expect(await bounded(close.promise)).toBe(1008);
    expect(await bounded(link.serverError)).toBe("auth_revoked");
    expect(link.frames.filter((frame) => frame.type === FrameType.WS_CLOSE)).toHaveLength(1);
  } finally { release.resolve(); }
});

it("hands admitted messages over before a peer's graceful close, without waiting for their handling", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const messages: string[] = [];
  const detached: number[] = [];
  const { link } = await connection(f, "drive", {
    websocket: {
      open() {},
      async message(socket, raw) {
        messages.push(String(raw));
        // answered as connections.send answers: a send refused (0) closes the socket as stalled
        if (String(raw) === "ping" && socket.send("pong") === 0) socket.close(4008, "output delivery failed");
        if (messages.length === 1) { entered.resolve(); await release.promise; }
      },
      close(_socket, code) { detached.push(code); }, drain() {},
    },
  });
  const stream = link.mux.openWs({ target: "/ws", headers: [], protocols: [] });
  const opened = deferred<void>();
  stream.onAccept = () => opened.resolve();
  const closed = deferred<number>();
  // a reply the server still sends reaches a handler, so this side's close can finish
  stream.onMessage = () => {};
  stream.onClose = (event) => closed.resolve(event.code);
  await bounded(opened.promise);
  // A carrier hands a burst over in one turn: the CLOSE then arrives before the messages
  // before it were handed over, which the mux does one microtask apart.
  const held: (string | ArrayBuffer)[] = [];
  const burst = deferred<void>();
  const receive = link.session.receive.bind(link.session);
  const holding = spyOn(link.session, "receive").mockImplementation((data) => {
    held.push(data);
    if (typeof data !== "string" && decodeFrame(new Uint8Array(data)).type === FrameType.WS_CLOSE) burst.resolve();
  });
  restores.push(() => holding.mockRestore());
  try {
    stream.send("first");
    stream.send("ping");
    stream.send("last");
    stream.close(1000);
    await bounded(burst.promise);
    holding.mockRestore();
    for (const data of held) receive(data);
    await bounded(entered.promise);
    await link.flush();
    // a native socket also hands the rest over while "first" is still being handled, still
    // open for a reply to each, and only then closes
    expect(messages).toEqual(["first", "ping", "last"]);
    expect(detached).toEqual([1000]);
    expect(await bounded(closed.promise)).toBe(1000);
    release.resolve();
    await link.flush();
    expect(messages).toEqual(["first", "ping", "last"]);
    expect(detached).toEqual([1000]);
  } finally { release.resolve(); }
});
