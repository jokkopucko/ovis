import { afterAll, afterEach, beforeAll, expect, it, jest } from "bun:test";
import { HerdrSocket } from "./ws.ts";
import { nativeTransport, setTransport, type WebSocketLike } from "./transport.ts";
import type { ClientConnectionTrace, PendingMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

/** A WebSocket the test drives: it opens, receives and records what the client sends. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { const frame = JSON.parse(data); this.sent.push(frame); this.emit("sent", frame); }
  nextSubmission(): Promise<{ id: number }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no submit frame")), 1_000);
      this.addEventListener("sent", (frame) => {
        if (frame.type === "submit") { clearTimeout(timeout); resolve(frame); }
      });
    });
  }
  close(): void { this.readyState = 3; }
  disconnect(): void { this.readyState = 3; this.emit("close", { code: 1006 }); }
  /** the closing handshake started (the server's close frame, or the error handler's close()); the close event comes later */
  closing(): void { this.readyState = 2; }
  closeEvent(code: number): void { this.readyState = 3; this.emit("close", { code }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open", {}); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
}

const globals = globalThis as unknown as { WebSocket?: unknown; window?: unknown };
const before = { WebSocket: globals.WebSocket, window: globals.window };
beforeAll(() => { globals.WebSocket = FakeSocket; globals.window = globalThis; });
afterAll(() => { globals.WebSocket = before.WebSocket; globals.window = before.window; });

const snapshot = (features: string[]) => ({ type: "snapshot", snapshot: { workspaces: [], panes: [], agents: [], layouts: [] }, features });
const secrets = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "secret");
const submissions = (socket: FakeSocket) => socket.sent.filter((frame) => ["submit", "input", "keys"].includes(frame.type));

it("refuses clear-and-send on a legacy bridge without sending payload or Enter", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot([]));
  try {
    expect(await client.submit("w1:p1", "chat message", "chat message", false, "immediate", "named draft"))
      .toMatchObject({ ok: false, code: "unsupported" });
    expect(submissions(socket)).toEqual([]);
  } finally {
    client.close();
  }
});

it("sends nothing when the bridge has not said what it supports by the end of the wait (#1591)", async () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  try {
    // no snapshot yet: whether this bridge takes `submit` is unknown, not "an older bridge"
    const result = client.submit("w1:p1", "chat message", "chat message");
    jest.advanceTimersByTime(2_000);
    // not a dropped connection: the socket is open, only its snapshot is late (#1806)
    expect(await result).toMatchObject({ ok: false, code: "capabilities_unknown" });
    expect(submissions(socket)).toEqual([]);
    // an Insert behind the same late snapshot is not told to update the PC: its bridge is unknown, not old
    const inserted = client.insert("w1:p1", "one line");
    jest.advanceTimersByTime(2_000);
    expect(await inserted).toMatchObject({ ok: false, code: "capabilities_unknown" });
    expect(socket.sent.filter((frame) => frame.type === "insert")).toEqual([]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("waits for the snapshot when the features frame is not trusted: nothing leaves, as on an older bridge (#2257)", async () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures((frame) => frame.herdr_lifetime === "known");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive({ type: "features", features: ["submit", "terminal-insert"], connection: "c1", herdr_lifetime: "replaced" });
  try {
    const result = client.submit("w1:p1", "chat message", "chat message");
    jest.advanceTimersByTime(2_000);
    expect(await result).toMatchObject({ ok: false, code: "capabilities_unknown" });
    expect(submissions(socket)).toEqual([]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("sends a chat message and an Insert once the server's features frame came, its snapshot still on its way", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures((frame) => frame.herdr_lifetime === "known");
  client.attach("w1:p1", 80, 24);
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // the snapshot waits on herdr (10 s after a restart, under load); what the server takes does not
  socket.receive({ type: "features", features: ["submit", "input-ready", "terminal-insert"], connection: "c1", herdr_lifetime: "known" });
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "chat message", "chat message");
    const frame = await sent;
    // the PC's clock before it typed, for the chat's waiting copy (lib/sentWaiting.ts)
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true, sending_at: "2026-11-06T09:00:00.000Z" });
    expect(await result).toEqual({ ok: true, sendingAt: "2026-11-06T09:00:00.000Z" });
    const insertSent = new Promise<{ id: number }>((resolve) => socket.addEventListener("sent", (candidate) => { if (candidate.type === "insert") resolve(candidate); }));
    const inserted = client.insert("w1:p1", "one line");
    const insert = await insertSent;
    socket.receive({ type: "insert-result", id: insert.id, pane_id: "w1:p1", ok: true });
    expect(await inserted).toEqual({ ok: true });
  } finally {
    client.close();
  }
});

it("keeps ordinary immediate sends working on a legacy bridge", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot([]));
  try {
    expect(await client.submit("w1:p1", "chat message", "chat message")).toEqual({ ok: true, unconfirmed: true });
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "chat message\r" }]);
  } finally {
    client.close();
  }
});

it("control: a held-copy id on a legacy bridge keeps its existing immediate input behavior", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot([]));
  try {
    expect(await client.submit("w1:p1", "held copy", "held copy", false, "immediate", undefined, false, "stable-copy-id")).toEqual({ ok: true, unconfirmed: true });
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "held copy\r" }]);
  } finally { client.close(); }
});

it("regression: sends the held-copy id independently of the connection request id", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "held copy", "held copy", false, "immediate", undefined, false, "stable-copy-id", 3);
    const frame = await sent;
    expect(submissions(socket)[0]?.resend_id).toBe("stable-copy-id");
    expect(submissions(socket)[0]?.resend_generation).toBe(3);
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
  } finally { client.close(); }
});

it("refuses a held-copy resend combined with Send anyway without sending a frame", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "held copy", "held copy", false, "immediate", undefined, true, "combined-copy", 0);
    const answer = await Promise.race([result, sent.then((frame) => {
      socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
      return result;
    })]);
    expect(answer).toMatchObject({ ok: false, code: "invalid_delivery" });
    expect(submissions(socket)).toEqual([]);
  } finally { client.close(); }
});

it("delivers partial clear outcomes unchanged and never retries the submission", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "keep composer text", "keep composer text", false, "immediate", "named draft");
    const frame = await sent;
    const fault = { ok: false, code: "submit_partial", message: "partial-outcome-fixture" };
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ...fault });
    expect(await result).toEqual(fault);
    expect(submissions(socket)).toHaveLength(1);
  } finally {
    client.close();
  }
});

it("waits for the bridge's pending-input capability before sending an explicit next turn", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  expect(client.canQueueMessages()).toBe(false);
  const result = client.submit("w1:p1", "next turn", "\x1b[200~next turn\x1b[201~", false, "queue");
  await Promise.resolve();
  expect(submissions(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(client.canQueueMessages()).toBe(true);
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "next turn", payload: "\x1b[200~next turn\x1b[201~", delivery: "queue" }]);
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "next turn", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
  expect(await result).toEqual({ ok: true, pending });
  client.close();
});

it("refuses queued delivery on older bridges without writing its text or a fallback key", async () => {
  for (const features of [[], ["submit"], ["pending-input"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    expect(client.canQueueMessages()).toBe(false);
    expect(await client.submit("w1:p1", "keep this draft", "keep this draft", false, "queue")).toMatchObject({ ok: false, code: "pending_input_unsupported" });
    expect(submissions(socket)).toEqual([]);
    client.close();
  }
});

it("holds a message for Send now on bridges that list pending-hold, and queues it on older ones", async () => {
  for (const [features, delivery] of [[["submit", "pending-input"], "queue"], [["submit", "pending-input", "pending-hold"], "hold"]] as const) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot([...features]));
    expect(client.canHoldMessages()).toBe(delivery === "hold");
    const result = client.submit("w1:p1", "later", "later", false, "hold");
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "later", payload: "later", delivery }]);
    const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "later", state: delivery === "hold" ? "held" : "queued", created_at: "2026-10-06T00:00:00Z" };
    socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
    expect(await result).toEqual({ ok: true, pending });
    client.close();
  }
});

// Alt+Enter's hold is only ever held: a PC that cannot hold one refuses it rather than queuing it to go on its own
it("refuses a hold-only message on bridges without pending-hold, writing nothing", async () => {
  for (const features of [["submit", "pending-input"], ["submit"], []]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    // a hold pressed before the snapshot is decided once it says what the bridge takes
    const result = client.submit("w1:p1", "keep this draft", "keep this draft", false, "hold", undefined, false, undefined, undefined, false, true);
    socket.receive(snapshot(features));
    let settled = false;
    void result!.then(() => { settled = true; });
    for (let turn = 0; turn < 10 && !settled && submissions(socket).length === 0; turn++) await Promise.resolve();
    // checked before the answer is awaited: a hold sent as a queued message would wait for a receipt that never comes
    expect(submissions(socket)).toEqual([]);
    expect(await result).toMatchObject({ ok: false, code: "pending_hold_unsupported" });
    expect(socket.sent.filter((frame) => JSON.stringify(frame).includes("keep this draft"))).toEqual([]);
    client.close();
  }
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input", "pending-hold"]));
  const result = client.submit("w1:p1", "later", "later", false, "hold", undefined, false, undefined, undefined, false, true);
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "later", payload: "later", delivery: "hold" }]);
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: false, code: "agent_not_ready", message: "fixture" });
  await result;
  client.close();
});

it("decides a hold once the snapshot arrives, so a Send before it still holds", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const result = client.submit("w1:p1", "later", "later", false, "hold");
  await Promise.resolve();
  expect(submissions(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input", "pending-hold"]));
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "later", payload: "later", delivery: "hold" }]);
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: false, code: "agent_not_ready", message: "fixture" });
  await result;
  client.close();
});

it("accepts an owner-only pending item as the submit receipt when its separate ACK was lost", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  const result = client.submit("w1:p1", "one accepted message", "one accepted message", false, "queue");
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "one accepted message", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await result).toEqual({ ok: true, pending });
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true, pending });
  expect(submissions(socket)).toHaveLength(1);
  client.close();
});

it("matches live queue receipts only to queued submits for the same captured pane", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  const queued = client.submit("w1:p1", "queued", "queued", false, "queue");
  const immediate = client.submit("w1:p1", "immediate", "immediate");
  const action = client.pendingAction("w1:p1", "pending-other", "steer");
  const settled: string[] = [];
  void queued?.then(() => settled.push("queued"));
  void immediate?.then(() => settled.push("immediate"));
  void action?.then(() => settled.push("action"));
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "pending-1", request_id: 1, text: "queued", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  socket.receive({ type: "pending-messages", pane_id: "w1:p2", messages: [pending] });
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [{ ...pending, request_id: 2 }, { ...pending, request_id: 3 }] });
  await Promise.resolve();
  expect(settled).toEqual([]);
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await queued).toEqual({ ok: true, pending });
  expect(settled).toEqual(["queued"]);
  socket.receive({ type: "submit-result", id: 2, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "pending-other", ok: true });
  expect(await immediate).toEqual({ ok: true });
  expect(await action).toEqual({ ok: true });
  client.close();
});

it("ignores a receipt from an old socket even when its request ID matches a new connection's queued submit", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const old = FakeSocket.last;
  old.open();
  old.receive(snapshot(["submit", "pending-input"]));
  old.disconnect();
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  let settled = false;
  const result = client.submit("w1:p1", "new connection", "new connection", false, "queue");
  void result?.then(() => { settled = true; });
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  const pending: PendingMessage = { id: "new-pending", request_id: 1, text: "new connection", state: "queued", created_at: "2026-10-06T00:00:00Z" };
  old.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.receive({ type: "pending-messages", pane_id: "w1:p1", messages: [pending] });
  expect(await result).toEqual({ ok: true, pending });
  client.close();
});

it("steers or discards an opaque pending ID once and waits for its action acknowledgement", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input"]));
  for (const [index, [action, withdrawalOnly]] of ([["steer", false], ["discard", false], ["discard", true]] as const).entries()) {
    const sent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no pending-action frame")), 1_000);
      socket.addEventListener("sent", (frame) => {
        if (frame.type === "pending-action") { clearTimeout(timeout); resolve(frame); }
      });
    });
    const result = client.pendingAction("w1:p1", "pending-1", action, undefined, withdrawalOnly);
    const frame = await sent;
    // launch_ended: this client tells a launch that ended apart, so the bridge answers it with that code (#1547)
    expect(frame).toEqual({ type: "pending-action", id: index + 1, pane_id: "w1:p1", pending_id: "pending-1", action, launch_ended: true,
      ...(withdrawalOnly ? { withdrawal_only: true } : {}) });
    socket.receive({ type: "pending-result", id: index + 1, pane_id: "w1:p1", pending_id: "pending-1", ok: index === 0, ...(index > 0 ? { code: "pending_not_found", message: "already sent" } : {}) });
    expect(await result).toEqual(index === 0 ? { ok: true } : { ok: false, code: "pending_not_found", message: "already sent" });
  }
  client.close();
});

it("requires acknowledgement kind and target to match, so pending results cannot confirm an immediate submit or secret", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "pending-input", "secret-input"]));
  const immediate = client.submit("w1:p1", "immediate", "immediate");
  const secret = client.sendSecret("w1:p1", "Password:", "private", () => true);
  const action = client.pendingAction("w1:p1", "pending-1", "steer");
  const settled: string[] = [];
  void immediate?.then(() => settled.push("immediate"));
  void secret?.then(() => settled.push("secret"));
  void action?.then(() => settled.push("action"));
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  for (const id of [1, 2]) socket.receive({ type: "pending-result", id, pane_id: "w1:p1", pending_id: "pending-1", ok: true });
  socket.receive({ type: "submit-result", id: 3, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "secret-result", id: 1, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p2", pending_id: "pending-1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "foreign-pending", ok: true });
  await Promise.resolve();
  expect(settled).toEqual([]);
  socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "secret-result", id: 2, pane_id: "w1:p1", ok: true });
  socket.receive({ type: "pending-result", id: 3, pane_id: "w1:p1", pending_id: "pending-1", ok: true });
  expect(await immediate).toEqual({ ok: true });
  expect(await secret).toEqual({ ok: true });
  expect(await action).toEqual({ ok: true });
  client.close();
});

it("refuses unsupported pending actions and never replays an action after disconnect", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.pendingAction("w1:p1", "pending-1", "steer")).toMatchObject({ ok: false, code: "pending_input_unsupported" });
  expect(socket.sent.filter((frame) => frame.type === "pending-action")).toEqual([]);
  socket.receive(snapshot(["submit", "pending-input"]));
  const result = client.pendingAction("w1:p1", "pending-1", "steer");
  for (let turn = 0; turn < 10 && socket.sent.filter((frame) => frame.type === "pending-action").length === 0; turn++) await Promise.resolve();
  socket.disconnect();
  expect(await result).toMatchObject({ ok: false, code: "disconnected" });
  expect(client.pendingAction("w1:p1", "pending-1", "discard")).toBeNull();
  client.connect();
  const reconnect = FakeSocket.last;
  reconnect.open();
  reconnect.receive(snapshot(["submit", "pending-input"]));
  expect(reconnect.sent.map((frame) => frame.type)).toEqual(["role"]);
  client.setMode("observe");
  expect(client.pendingAction("w1:p1", "pending-1", "steer")).toBeNull();
  client.close();
});

it("settles a pending action whose connection dropped before it was sent as not transmitted (regression #541)", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // waiting for the snapshot that says the bridge takes pending actions
  const result = client.pendingAction("w1:p1", "pending-1", "steer");
  const submit = client.submit("w1:p1", "held copy", "held copy", false, "immediate", undefined, false, "pending-2", 0);
  socket.disconnect();
  expect(await result).toMatchObject({ ok: false, code: "not_transmitted" });
  expect(await submit).toMatchObject({ ok: false, code: "not_transmitted" });
  expect(socket.sent.filter((frame) => ["pending-action", "submit"].includes(frame.type))).toEqual([]);
  client.close();
});

it("keeps existing Enter submits and the older bridge's input fallback compatible", async () => {
  for (const features of [[], ["submit"], ["submit", "pending-input"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    const result = client.submit("w1:p1", "steer now", "steer now", true);
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    if (features.includes("submit")) {
      expect(submissions(socket)).toEqual([{ type: "submit", id: 1, pane_id: "w1:p1", text: "steer now", payload: "steer now", typed: true }]);
      socket.receive({ type: "submit-result", id: 1, pane_id: "w1:p1", ok: true });
    } else expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "steer now\r" }]);
    expect(await result).toEqual(features.includes("submit") ? { ok: true } : { ok: true, unconfirmed: true });
    client.close();
  }
});

it("never replays a queued submit after disconnecting, including before its capability snapshot arrives", async () => {
  for (const known of [false, true]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    client.attach("w1:p1", 80, 24);
    if (known) socket.receive(snapshot(["submit", "pending-input"]));
    const result = client.submit("w1:p1", "do not replay", "do not replay", false, "queue");
    for (let turn = 0; turn < 10 && known && submissions(socket).length === 0; turn++) await Promise.resolve();
    socket.disconnect();
    // regression #541: before its snapshot no frame left, so it is not sent rather than not confirmed
    expect(await result).toMatchObject({ ok: false, code: known ? "disconnected" : "not_transmitted" });
    expect(client.canQueueMessages()).toBe(false);
    expect(client.submit("w1:p1", "offline", "offline", false, "queue")).toBeNull();
    client.connect();
    const reconnect = FakeSocket.last;
    reconnect.open();
    reconnect.receive(snapshot(["submit", "pending-input"]));
    await Promise.resolve();
    expect(reconnect.sent.map((frame) => frame.type)).toEqual(["role", "attach"]);
    expect(submissions(socket).length).toBe(known ? 1 : 0);
    client.close();
  }
});

it("sends no submit while observing, including a role change while waiting for the snapshot", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const pending = client.submit("w1:p1", "not while observing", "not while observing", false, "queue");
  client.setMode("observe");
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(await pending).toMatchObject({ ok: false, code: "read_only" });
  expect(client.canQueueMessages()).toBe(false);
  expect(client.submit("w1:p1", "no Enter either", "no Enter either")).toBeNull();
  expect(submissions(socket)).toEqual([]);
  client.close();
});

it("applies a server-forced observe acknowledgement before a pending submit wakes on the first snapshot", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const pending = client.submit("w1:p1", "keep this draft", "keep this draft", false, "queue");
  socket.receive({ type: "role-ack", mode: "observe" });
  socket.receive(snapshot(["submit", "pending-input"]));
  expect(await pending).toMatchObject({ ok: false, code: "read_only" });
  expect(client.canQueueMessages()).toBe(false);
  expect(client.submit("w1:p1", "no input while watching", "no input while watching")).toBeNull();
  expect(submissions(socket)).toEqual([]);
  socket.receive({ type: "role-ack", mode: "interact" });
  expect(client.canQueueMessages()).toBe(true);
  client.on((message) => { if (message.type === "role-ack") expect(client.canQueueMessages()).toBe(false); });
  socket.receive({ type: "role-ack", mode: "observe" });
  expect(submissions(socket)).toEqual([]);
  client.close();
});

it("sends a secret entered before the reconnect's snapshot arrived, once the snapshot lists masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // terminal output is already on screen and the masked field is up; the snapshot is still on its way
  const result = client.sendSecret("w1:p1", "Password:", "hunter2", () => true);
  expect(result).not.toBeNull();
  await Promise.resolve();
  expect(secrets(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "secret-input"]));
  // the secret goes out as soon as the snapshot is in, not at the wait's deadline
  for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
  expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: "Password:", secret: "hunter2" }]);
  socket.receive({ type: "secret-result", id: secrets(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  expect(await result).toEqual({ ok: true });
  client.close();
});

it("types a secret for a prompt only a newer bridge takes as direct input to a bridge that does not say it takes it", async () => {
  const git = "Password for 'https://alice@github.com':";
  const typed = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "input");
  // the value, then Enter in a frame of its own, neither with an id
  const asTyped = [{ type: "input", pane_id: "w1:p1", text: "hunter2" }, { type: "input", pane_id: "w1:p1", text: "\r" }];
  // a bridge with masked input but not the wider prompts, and one with neither: both would refuse the `secret`
  for (const features of [["submit", "secret-input"], ["submit"]]) {
    const { client, socket } = liveClient(features);
    expect(await client.sendSecret("w1:p1", git, "hunter2", () => true)).toEqual({ ok: true });
    expect(secrets(socket)).toEqual([]);
    expect(typed(socket)).toEqual(asTyped);
    // a prompt every bridge takes still goes as a `secret` where masked input is known
    const earlier = client.sendSecret("w1:p1", "Password:", "hunter2", () => true);
    if (features.includes("secret-input")) {
      for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
      expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: "Password:", secret: "hunter2" }]);
    } else expect(await earlier).toMatchObject({ ok: false, code: "unsupported" });
    expect(typed(socket)).toEqual(asTyped);
    client.close();
  }
  // a released bridge gives typing an id and keeps it until the bridge has read it, to hold it for review when the
  // connection ends first: a typed secret gets no id and is never kept
  const { client, socket } = liveClient(["submit", "secret-input", "ping", "input-receipt"]);
  expect(await client.sendSecret("w1:p1", git, "hunter2", () => true)).toEqual({ ok: true });
  expect(typed(socket)).toEqual(asTyped);
  socket.disconnect();
  expect(client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  client.close();
  // a pane that takes no typing: nothing goes out, and the field says to check the terminal
  const idle = new HerdrSocket("ws://test/ws");
  idle.connect();
  const idleSocket = FakeSocket.last;
  idleSocket.open();
  idleSocket.receive(snapshot(["submit", "secret-input"]));
  expect(await idle.sendSecret("w1:p1", git, "hunter2", () => true)).toMatchObject({ ok: false, code: "input_unavailable" });
  expect([...secrets(idleSocket), ...typed(idleSocket)]).toEqual([]);
  idle.close();
});

it("types no secret into another attachment, past a prompt that left, or before the bridge said what it takes", async () => {
  const git = "Password for 'https://alice@github.com':";
  const sent = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "input" || frame.type === "secret");
  // nothing on an older bridge checks its screen for typing, so the page does
  const left = liveClient(["submit", "secret-input"]);
  expect(await left.client.sendSecret("w1:p1", git, "hunter2", () => false)).toMatchObject({ ok: false, code: "prompt_changed" });
  expect(sent(left.socket)).toEqual([]);
  left.client.close();
  // the pane was let go and attached again while the features were awaited: the field was sent for the first attachment
  const again = new HerdrSocket("ws://test/ws");
  again.attach("w1:p1", 100, 30);
  again.connect();
  const againSocket = FakeSocket.last;
  againSocket.open();
  againSocket.receive({ type: "input-ready", pane_id: "w1:p1" });
  const waiting = again.sendSecret("w1:p1", git, "hunter2", () => true);
  again.detach("w1:p1");
  again.attach("w1:p1", 100, 30);
  againSocket.receive(snapshot(["input-ready", "submit", "secret-input"]));
  againSocket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(await waiting).toMatchObject({ ok: false, code: "prompt_changed" });
  expect(sent(againSocket)).toEqual([]);
  again.close();
  // a snapshot that never came: a bridge that takes the prompt would have checked its own screen (#1591)
  jest.useFakeTimers();
  const late = new HerdrSocket("ws://test/ws");
  late.attach("w1:p1", 100, 30);
  late.connect();
  const lateSocket = FakeSocket.last;
  lateSocket.open();
  lateSocket.receive({ type: "input-ready", pane_id: "w1:p1" });
  try {
    const result = late.sendSecret("w1:p1", git, "hunter2", () => true);
    jest.advanceTimersByTime(2_000);
    expect(await result).toMatchObject({ ok: false, code: "capabilities_unknown" });
    expect(sent(lateSocket)).toEqual([]);
  } finally {
    jest.useRealTimers();
    late.close();
  }
});

it("types no secret behind a send of this page that the pane has not answered, and an empty one as Enter alone", async () => {
  const git = "Password for 'https://alice@github.com':";
  const typed = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "input");
  const { client, socket } = liveClient(["submit", "secret-input"]);
  const message = client.submit("w1:p1", "chat message", "chat message");
  for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
  expect(submissions(socket)).toHaveLength(1);
  // an older bridge types that message first, into the prompt, and the value would land on whatever follows it
  expect(await client.sendSecret("w1:p1", git, "hunter2", () => true)).toMatchObject({ ok: false, code: "pane_busy" });
  expect(typed(socket)).toEqual([]);
  socket.receive({ type: "submit-result", id: submissions(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  await message;
  // the screen is asked last, after every wait: a prompt that left meanwhile gets nothing
  let visible = true;
  const gone = client.sendSecret("w1:p1", git, "hunter2", () => visible);
  visible = false;
  expect(await gone).toMatchObject({ ok: false, code: "prompt_changed" });
  expect(typed(socket)).toEqual([]);
  // ssh-keygen's offer of no passphrase: Enter alone, with no frame of empty text before it
  expect(await client.sendSecret("w1:p1", "Enter passphrase (empty for no passphrase):", "", () => true)).toEqual({ ok: true });
  expect(typed(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "\r" }]);
  client.close();
});

it("sends a secret for a prompt of the wider set as a secret to a bridge that takes it", async () => {
  const git = "Password for 'https://alice@github.com':";
  const { client, socket } = liveClient(["submit", "secret-input", "secret-prompts-2"]);
  const result = client.sendSecret("w1:p1", git, "hunter2", () => true);
  for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
  expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: git, secret: "hunter2" }]);
  expect(socket.sent.filter((frame) => frame.type === "input")).toEqual([]);
  socket.receive({ type: "secret-result", id: secrets(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  expect(await result).toEqual({ ok: true });
  client.close();
});

it("answers unsupported, sending nothing, when the snapshot lists no masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.sendSecret("w1:p1", "Password:", "hunter2", () => true)).toMatchObject({ ok: false, code: "unsupported" });
  expect(secrets(socket)).toEqual([]);
  client.close();
});

it("requires attachment readiness and never replays held input after a detach", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready"]));
  client.attach("w1:p1", 80, 24);
  expect(client.sendInput("w1:p1", "lost?")).toBe(false);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(false);
  socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "한글")).toBe(true);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(true);
  // a key or text of an attach that has gone is refused with `input_failed`: this attach stays ready
  socket.receive({ type: "error", code: "input_failed", message: "stale", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(true);
  socket.receive({ type: "error", code: "input_not_ready", message: "not ready", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.canInput("w1:p1")).toBe(true);
  client.detach("w1:p1");
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "wrong pane")).toBe(false);
  expect(client.sendKeys("w1:p1", ["ctrl+alt+shift+left"])).toBe(false);
  expect(socket.sent.filter((m) => m.type === "keys")).toEqual([{ type: "keys", pane_id: "w1:p1", keys: ["ctrl+alt+shift+left"] }]);
  expect(socket.sent.filter((m) => m.type === "input")).toEqual([{ type: "input", pane_id: "w1:p1", text: "한글" }]);
  client.close();
});

it("marks only the composer's Stop as a Stop on the wire", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready"]));
  client.attach("w1:p1", 80, 24);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "\u001b")).toBe(true);
  expect(client.sendInput("w1:p1", "\u001b", true)).toBe(true);
  expect(socket.sent.filter((m) => m.type === "input")).toEqual([
    { type: "input", pane_id: "w1:p1", text: "\u001b" },
    { type: "input", pane_id: "w1:p1", text: "\u001b", stop: true },
  ]);
  client.close();
});

it("takes a held pane only from a server that knows how, while interacting with an attached pane", () => {
  const takes = (socket: FakeSocket) => socket.sent.filter((m) => m.type === "take-over");
  const old = new HerdrSocket("ws://test/ws");
  old.connect();
  const oldSocket = FakeSocket.last;
  oldSocket.open();
  oldSocket.receive(snapshot(["submit", "input-ready"]));
  old.attach("w1:p1", 80, 24);
  expect(old.canTakeOver()).toBe(false);
  expect(old.takeOver("w1:p1")).toBe(false);
  expect(takes(oldSocket)).toEqual([]);
  old.close();

  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "take-over"]));
  expect(client.takeOver("w1:p1")).toBe(false);
  client.attach("w1:p1", 80, 24);
  expect(client.takeOver("w1:p1")).toBe(true);
  // The open handler replays role and attach state, never the explicit takeover.
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "take-over"]));
  expect(takes(socket)).toEqual([{ type: "take-over", pane_id: "w1:p1" }]);
  client.setMode("observe");
  expect(client.takeOver("w1:p1")).toBe(false);
  expect(takes(socket)).toEqual([{ type: "take-over", pane_id: "w1:p1" }]);
  client.close();
  expect(client.takeOver("w1:p1")).toBe(false);
});

it("attaches a grid the chat lens covers without resizing the shared pty, on a reconnect too, until it drives the size again", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  const lastAttach = () => socket.sent.filter((m) => m.type === "attach").at(-1);
  // attached before the socket opened: the open replays it, as a reconnect does
  client.attach("w1:p1", 40, 20, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 40, rows: 20, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true });
  // the terminal lens is shown and resizes: from then on it drives the size
  client.resize("w1:p1", 100, 30, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String) });
  // the chat lens covers it again
  client.keepSize("w1:p1");
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true });
  client.close();
});

it("releases the shared grid once when the chat lens covers a terminal this tab sized, never replayed", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const releases = () => socket.sent.filter((m) => m.type === "release-size");
  const lastAttach = () => socket.sent.filter((m) => m.type === "attach").at(-1);
  // opened in the chat lens: this tab never sized the pty, so it has nothing to release
  client.attach("w1:p1", 40, 20, true);
  client.releaseSize("w1:p1");
  expect(releases()).toEqual([]);
  // the terminal lens sized it, then the chat lens covers it: one release, and the attach keeps the size
  client.resize("w1:p1", 53, 33, true);
  client.releaseSize("w1:p1");
  client.releaseSize("w1:p1");
  expect(releases()).toEqual([{ type: "release-size", pane_id: "w1:p1" }]);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 53, rows: 33, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true });
  expect(releases()).toHaveLength(1);
  // an observer never drives the grid, so it never releases it either
  client.setMode("observe");
  client.resize("w1:p1", 60, 20, true);
  client.releaseSize("w1:p1");
  expect(releases()).toHaveLength(1);
  client.close();
});

it("keeps a visible unfocused grid while changing only its reconnect policy", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const releases = () => socket.sent.filter((m) => m.type === "release-size");
  try {
    client.attach("w1:p1", 120, 40);
    // A plain blur does not hide the terminal or discard its fallback grid.
    client.keepSize("w1:p1", false);
    // Regression (fails on #1085): no release until the terminal really stops showing.
    expect(releases()).toEqual([]);
    client.releaseSize("w1:p1");
    client.releaseSize("w1:p1");
    expect(releases()).toEqual([{ type: "release-size", pane_id: "w1:p1" }]);
    client.resize("w1:p1", 120, 40);
    client.keepSize("w1:p1", false);
    socket.open();
    // Control: blur still changes the reconnect policy, without replaying a release.
    expect(socket.sent.filter((m) => m.type === "attach").at(-1))
      .toEqual({ type: "attach", pane_id: "w1:p1", cols: 120, rows: 40, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true });
    expect(releases()).toHaveLength(1);
  } finally {
    client.close();
  }
});

it("releases the shared grid once when a hidden terminal returns directly to Chat", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  const releases = () => socket.sent.filter((m) => m.type === "release-size");
  try {
    client.attach("w1:p1", 53, 33);
    // Selecting another pane must release its grid immediately, even if Chat never opens.
    client.keepSize("w1:p1");
    // regression (fails on main): hiding itself removes this client's server-side grid.
    expect(releases()).toEqual([{ type: "release-size", pane_id: "w1:p1" }]);
    // A notification selects this pane and Chat together, without a terminal-return resize.
    client.releaseSize("w1:p1");
    client.releaseSize("w1:p1");
    expect(releases()).toEqual([{ type: "release-size", pane_id: "w1:p1" }]);
    socket.open();
    client.releaseSize("w1:p1");
    expect(releases()).toHaveLength(1);
    expect(socket.sent.filter((m) => m.type === "attach").at(-1))
      .toEqual({ type: "attach", pane_id: "w1:p1", cols: 53, rows: 33, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true });
    // Showing the terminal again at the same dimensions still reclaims its released grid.
    client.resize("w1:p1", 53, 33);
    expect(socket.sent.at(-1)).toEqual({ type: "resize", pane_id: "w1:p1", cols: 53, rows: 33 });
    client.keepSize("w1:p1");
    expect(releases()).toHaveLength(2);
  } finally {
    client.close();
  }
});

it("sends no resize for a pane it let go of, and does not attach it again on a reconnect", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  client.attach("w1:p1", 100, 30);
  // a tab out of use lets go of its pane: herdr gives the pane back to its own TUI
  client.detach("w1:p1");
  const after = socket.sent.length;
  // the server would apply this to the attach of whoever holds the pane now
  client.resize("w1:p1", 120, 40, true);
  socket.open();
  expect(socket.sent.slice(after).filter((m) => m.type === "attach" || m.type === "resize")).toEqual([]);
  // the user is back: it attaches at its own size again
  client.attach("w1:p1", 120, 40);
  expect(socket.sent.at(-1)).toEqual({ type: "attach", pane_id: "w1:p1", cols: 120, rows: 40, flow_control: "ack", receipt_resume_id: expect.any(String) });
  client.close();
});

it("watches a pane it let go of only on a server that can, again after a reconnect, and ends the watch on one that cannot", () => {
  const client = new HerdrSocket("ws://test/ws");
  const ended: string[] = [];
  client.on((message) => { if (message.type === "watch-end") ended.push(message.pane_id); });
  client.connect();
  let socket = FakeSocket.last;
  socket.open();
  // asked before the snapshot says what the server can: it goes out once the snapshot does
  expect(client.watch("w1:p1", 100, 30)).toBe(true);
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 100, rows: 30 }]);
  // a reconnect watches again, at the grid last asked for, and attaches nothing
  expect(client.watch("w1:p1", 120, 40)).toBe(true);
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type !== "role")).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 120, rows: 40 }]);
  // the server ended it: a later reconnect does not ask for it again
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["watch"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  // a reconnect to a bridge without the view ends the tab's watch instead of sending a frame it does not know
  expect(client.watch("w1:p2", 80, 24)).toBe(true);
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([]);
  expect(ended).toEqual(["w1:p1", "w1:p2"]);
  expect(client.watch("w1:p2", 80, 24)).toBe(false);
  client.close();
});

/** Answers every ping the client sent and the fake server has not answered yet, as the bridge does in order. */
const answerPings = (socket: FakeSocket, answered: Set<unknown>) => {
  for (const frame of socket.sent) if (frame.type === "ping" && !answered.has(frame.id)) {
    answered.add(frame.id);
    socket.receive({ type: "pong", id: frame.id });
  }
};

const watchClient = (features = ["watch", "ping"]) => {
  const client = new HerdrSocket("ws://test/ws");
  const ended: string[] = [];
  client.on((message) => { if (message.type === "watch-end") ended.push(message.pane_id); });
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(features));
  const frames = () => socket.sent.filter((m) => m.type === "watch" || m.type === "unwatch");
  return { client, ended, socket, frames };
};

it("keeps a new watch when the unwatched view's end arrives after it, so the next unwatch still goes out", () => {
  const { client, ended, socket, frames } = watchClient();
  const answered = new Set<unknown>();
  client.watch("w1:p1", 100, 30);
  client.unwatch("w1:p1");
  client.watch("w1:p1", 100, 30);
  // the first view's end, sent before the server read the unwatch
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  expect(ended).toEqual([]);
  client.unwatch("w1:p1");
  expect(frames().map((m) => m.type)).toEqual(["watch", "unwatch", "watch", "watch", "unwatch"]);
  // once the server answered past every superseded view, a view that ends is ended for the page
  client.watch("w1:p1", 100, 30);
  answerPings(socket, answered);
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  expect(ended).toEqual(["w1:p1"]);
  client.unwatch("w1:p1");
  expect(frames().at(-1)).toEqual({ type: "watch", pane_id: "w1:p1", cols: 100, rows: 30 });
  client.close();
});

it("absorbs the late ends of two superseded views, so the newest unwatch still goes out", () => {
  const { client, ended, socket, frames } = watchClient();
  client.watch("w1:p1", 100, 30);
  client.unwatch("w1:p1");
  client.watch("w1:p1", 100, 30);
  client.unwatch("w1:p1");
  client.watch("w1:p1", 100, 30);
  // both earlier views ended before the server read their unwatch
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  expect(ended).toEqual([]);
  const sent = frames().length;
  client.unwatch("w1:p1");
  expect(frames().slice(sent)).toEqual([{ type: "unwatch", pane_id: "w1:p1" }]);
  client.close();
});

it("honours a view's own end after an unwatch once the server has read that unwatch", () => {
  const { client, ended, socket, frames } = watchClient();
  const answered = new Set<unknown>();
  client.watch("w1:p1", 100, 30);
  client.unwatch("w1:p1");
  // the pong of a ping sent after the unwatch: the unwatched view can no longer end on a new one
  answerPings(socket, answered);
  client.watch("w1:p1", 100, 30);
  const sent = frames().length;
  socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  expect(ended).toEqual(["w1:p1"]);
  // the view is over: it is not started again, and there is nothing left to unwatch
  client.unwatch("w1:p1");
  expect(frames().slice(sent)).toEqual([]);
  client.close();
});

it("re-sends a replacement watch the server cannot start at most once, then lets its end reach the page", () => {
  const { client, ended, socket, frames } = watchClient();
  client.watch("w1:p1", 100, 30);
  const start = socket.sent.length;
  // a resize replaces the running view; the server cannot start the new one, so it ends it at once,
  // answering each frame in order (its end comes before the pong of the ping sent after the watch)
  client.watch("w1:p1", 120, 40);
  for (let i = start; i < socket.sent.length && i < start + 100; i += 1) {
    const frame = socket.sent[i]!;
    if (frame.type === "watch") socket.receive({ type: "watch-end", pane_id: "w1:p1" });
    if (frame.type === "ping") socket.receive({ type: "pong", id: frame.id });
  }
  expect(frames().length - 1).toBeLessThanOrEqual(2);
  expect(ended).toEqual(["w1:p1"]);
  client.close();
});

// A bridge without "ping" cannot fence a superseded view's end, so the client tracks none: every end
// reaches the page and nothing is re-sent or kept, and the page's next watch and unwatch both go out.
const expectUntrackedEnds = ({ client, ended, socket, frames }: ReturnType<typeof watchClient>, ends: number) => {
  const sent = frames().length;
  for (let i = 0; i < ends; i += 1) socket.receive({ type: "watch-end", pane_id: "w1:p1" });
  expect(ended).toEqual(Array.from({ length: ends }, () => "w1:p1"));
  expect(frames().slice(sent)).toEqual([]);
  expect(socket.sent.some((m) => m.type === "ping")).toBe(false);
  client.watch("w1:p1", 100, 30);
  client.unwatch("w1:p1");
  expect(frames().slice(sent)).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 100, rows: 30 }, { type: "unwatch", pane_id: "w1:p1" }]);
  client.close();
};

it("tracks no superseded end on a bridge without ping: two late ends after two unwatches each reach the page", () => {
  const watching = watchClient(["watch"]);
  watching.client.watch("w1:p1", 100, 30);
  watching.client.unwatch("w1:p1");
  watching.client.watch("w1:p1", 100, 30);
  watching.client.unwatch("w1:p1");
  watching.client.watch("w1:p1", 100, 30);
  expectUntrackedEnds(watching, 2);
});

it("tracks no superseded end on a bridge without ping: a replaced view's late end reaches the page", () => {
  const replaced = watchClient(["watch"]);
  replaced.client.watch("w1:p1", 100, 30);
  replaced.client.watch("w1:p1", 120, 40);
  expectUntrackedEnds(replaced, 1);

  const both = watchClient(["watch"]);
  both.client.watch("w1:p1", 100, 30);
  both.client.unwatch("w1:p1");
  both.client.watch("w1:p1", 100, 30);
  both.client.watch("w1:p1", 120, 40);
  expectUntrackedEnds(both, 2);
});

it("restores watches and chat interest once per connection: on the features frame, not again on the snapshot", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures(() => true);
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  expect(client.watch("w1:p1", 100, 30)).toBe(true);
  socket.receive({ type: "features", features: ["watch", "submit"], connection: "c1" });
  expect(socket.sent.filter((m) => m.type === "watch")).toEqual([{ type: "watch", pane_id: "w1:p1", cols: 100, rows: 30 }]);
  // the snapshot lists the same features: nothing is asked twice
  socket.receive(snapshot(["watch", "submit"]));
  expect(socket.sent.filter((m) => m.type === "watch")).toHaveLength(1);
  expect(client.canWatch()).toBe(true);
  client.close();
});

it("lets a pane replace a background reconnect's attach with a watch before replay", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  let socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["watch"]));
  client.attach("w1:p1", 140, 40);
  client.attach("w1:p2", 100, 30);
  const off = client.onBeforeReplay(() => {
    client.detach("w1:p1");
    client.watch("w1:p1", 140, 40);
  });
  try {
    socket.disconnect();
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    expect(socket.sent.filter((frame) => frame.type === "attach").map((frame) => frame.pane_id)).toEqual(["w1:p2"]);
    expect(socket.sent.filter((frame) => frame.type === "watch")).toEqual([]);
    socket.receive(snapshot(["watch"]));
    expect(socket.sent.filter((frame) => frame.type === "watch")).toEqual([
      { type: "watch", pane_id: "w1:p1", cols: 140, rows: 40 },
    ]);
    client.resize("w1:p1", 80, 24, true);
    expect(socket.sent.filter((frame) => frame.type === "resize")).toEqual([]);
    off();
    client.unwatch("w1:p1");
    client.attach("w1:p1", 140, 40);
    socket.disconnect();
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    expect(socket.sent.filter((frame) => frame.type === "attach").map((frame) => frame.pane_id)).toEqual(["w1:p2", "w1:p1"]);
  } finally { off(); client.close(); }
});

it("discovers watch support anew before each connection's attach replay", () => {
  const client = new HerdrSocket("ws://test/ws");
  const capabilities: boolean[] = [];
  client.onBeforeReplay(() => capabilities.push(client.canWatch()));
  try {
    client.connect();
    let socket = FakeSocket.last;
    socket.open();
    expect(client.canWatch()).toBe(true);
    socket.receive(snapshot([]));
    expect(client.canWatch()).toBe(false);
    expect(client.watch("w1:p1", 100, 30)).toBe(false);
    socket.disconnect();
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    expect(client.canWatch()).toBe(true);
    socket.receive(snapshot(["watch"]));
    expect(client.canWatch()).toBe(true);
    expect(capabilities).toEqual([true, true]);
  } finally { client.close(); }
});

it("keeps a pane's scrollback in the browser only for a server that says it has none of its own", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures(() => true);
  const seen: boolean[] = [];
  // a pane hears the features frame after the socket learned them, and sizes its scrollback by it
  const off = client.on((message) => { if (message.type === "features") seen.push(client.hasTerminalHistory()); });
  try {
    client.connect();
    let socket = FakeSocket.last;
    socket.open();
    expect(client.hasTerminalHistory()).toBe(false);
    socket.receive({ type: "features", features: ["submit", "terminal-history"], connection: "c1" });
    expect(seen).toEqual([true]);
    // a reconnect to herdr's own server (its TUI keeps the history) forgets it
    socket.disconnect();
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    expect(client.hasTerminalHistory()).toBe(false);
    socket.receive(snapshot(["watch", "submit"]));
    expect(client.hasTerminalHistory()).toBe(false);
  } finally { off(); client.close(); }
});

// #2664 review: an untrusted features frame lowered the scrollback, and history replayed before the snapshot was cut
it("keeps a pane's scrollback on from a features frame it does not trust yet", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures(() => false);
  try {
    client.connect();
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: "features", features: ["submit", "terminal-history"], connection: "c1" });
    expect(client.hasTerminalHistory()).toBe(true);
  } finally { client.close(); }
});

it("waits for capabilities when output precedes snapshot, and supports old bridges", () => {
  for (const features of [["input-ready"], []]) {
    const client = new HerdrSocket("ws://test/ws"); client.connect();
    const socket = FakeSocket.last; socket.open(); client.attach("w1:p1", 80, 24);
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive(snapshot(features));
    expect(client.canInput("w1:p1")).toBe(features.length === 0);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.canInput("w1:p1")).toBe(true);
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    expect(client.sendInput("w1:p1", "no replay")).toBe(false);
    client.close();
  }
});

it("asks again for a visible chat's conversation pushes when its pane is attached again", () => {
  const client = new HerdrSocket("ws://test/ws"); client.connect();
  const socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["conversation-watch"]));
  const watches = () => socket.sent.filter((frame) => frame.type === "conversation-watch");
  // the chat can ask before its pane's attach goes out; the attach carries the interest
  client.watchConversation("w1:p1", true);
  expect(watches()).toEqual([]);
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toEqual([{ type: "conversation-watch", pane_id: "w1:p1", enabled: true }]);
  // a tab out of use lets go of its pane: the bridge drops the interest, the visible chat keeps it
  client.detach("w1:p1");
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toHaveLength(2);
  // a chat that took its interest back is not watched by the next attach
  client.watchConversation("w1:p1", false);
  client.detach("w1:p1");
  client.attach("w1:p1", 80, 24, true);
  expect(watches()).toEqual([
    { type: "conversation-watch", pane_id: "w1:p1", enabled: true },
    { type: "conversation-watch", pane_id: "w1:p1", enabled: true },
    { type: "conversation-watch", pane_id: "w1:p1", enabled: false },
  ]);
  client.close();
});

it("sends no conversation-watch to a bridge without the feature, and reports no pushes so the chat polls", () => {
  const client = new HerdrSocket("ws://test/ws"); client.connect();
  let socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["submit", "pending-input", "secret-input", "input-ready", "take-over", "watch"]));
  client.watchConversation("w1:p1", true);
  client.attach("w1:p1", 80, 24, true);
  expect(socket.sent.filter((frame) => frame.type === "conversation-watch")).toEqual([]);
  expect(client.conversationPushes()).toBe(false);
  // a reconnect to the same older bridge does not replay the interest either
  socket.disconnect();
  client.connect();
  socket = FakeSocket.last; socket.open();
  socket.receive(snapshot(["submit"]));
  expect(socket.sent.filter((frame) => frame.type === "conversation-watch")).toEqual([]);
  expect(client.conversationPushes()).toBe(false);
  client.close();
});

it("tells the server whether the page is in use: on connect, on a change, and again after a reconnect", () => {
  const presence = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "presence");
  const client = new HerdrSocket("ws://test/ws");
  client.setPresence(true);
  client.connect();
  const first = FakeSocket.last;
  first.open();
  expect(first.sent.map((frame) => frame.type)).toEqual(["role", "presence"]);
  client.setPresence(true);
  client.setPresence(false);
  expect(presence(first)).toEqual([{ type: "presence", active: true }, { type: "presence", active: false }]);
  first.disconnect();
  client.connect();
  const second = FakeSocket.last;
  second.open();
  expect(presence(second)).toEqual([{ type: "presence", active: false }]);
  client.close();
});

it("reconnects at once when the page wakes instead of waiting out the backoff, and starts the backoff over", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const first = FakeSocket.last;
  first.open();
  // a phone asleep: each attempt fails and the backoff grows toward its cap
  first.disconnect();
  for (let attempt = 0; attempt < 5; attempt++) {
    client.wake();
    FakeSocket.last.disconnect();
  }
  const sleeping = FakeSocket.last;
  client.wake();
  expect(FakeSocket.last).not.toBe(sleeping);
  const woken = FakeSocket.last;
  woken.open();
  expect(woken.sent.map((frame) => frame.type)).toEqual(["role"]);
  // a live connection has no timer to skip: waking opens nothing more
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  client.close();
});

it("backs off repeated short-lived opens, even when each receives a snapshot and terminal readiness", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    let current = socket;
    for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      current.disconnect();
      expect(client.state).toBe("waiting");
      jest.advanceTimersByTime(delay - 1);
      expect(FakeSocket.last).toBe(current);
      jest.advanceTimersByTime(1);
      const next = FakeSocket.last;
      expect(next).not.toBe(current);
      next.open();
      next.receive(snapshot(["input-ready"]));
      next.receive({ type: "input-ready", pane_id: "w1:p1" });
      expect(client.canInput("w1:p1")).toBe(true);
      expect(next.sent.filter((frame) => frame.type === "attach")).toHaveLength(1);
      current = next;
    }
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("starts the retry delay over only after an open connection has stayed up for 10s", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const short = FakeSocket.last;
    short.open();
    jest.advanceTimersByTime(9_999);
    short.disconnect();
    jest.advanceTimersByTime(499);
    expect(FakeSocket.last).toBe(short);
    jest.advanceTimersByTime(1);
    const stable = FakeSocket.last;
    expect(stable).not.toBe(short);
    stable.open();
    jest.advanceTimersByTime(10_000);
    stable.disconnect();
    jest.advanceTimersByTime(249);
    expect(FakeSocket.last).toBe(stable);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(stable);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ignores a late open from an abandoned attempt instead of replaying on the replacement", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.attach("w1:p1", 100, 30);
    client.connect();
    const abandoned = FakeSocket.last;
    jest.advanceTimersByTime(8_000);
    jest.advanceTimersByTime(250);
    const replacement = FakeSocket.last;
    expect(replacement).not.toBe(abandoned);
    replacement.open();
    const sent = [...replacement.sent];
    abandoned.open();
    expect(replacement.sent).toEqual(sent);
    expect(client.state).toBe("open");
    replacement.disconnect();
    jest.advanceTimersByTime(499);
    expect(FakeSocket.last).toBe(replacement);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(replacement);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("still bypasses a flapping connection's backoff on wake and resets its next retry", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const second = FakeSocket.last;
    second.open();
    second.disconnect();
    client.wake();
    const woken = FakeSocket.last;
    expect(woken).not.toBe(second);
    woken.open();
    woken.disconnect();
    jest.advanceTimersByTime(249);
    expect(FakeSocket.last).toBe(woken);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(woken);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("does not wake a connection whose output stopped, nor one that was closed", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  (socket as unknown as { emit(type: string, event: unknown): void }).emit("close", { code: OUTPUT_STALLED_CLOSE_CODE });
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  client.close();
  client.wake();
  expect(FakeSocket.last).toBe(socket);
});

it("gives up a connect attempt stuck in CONNECTING after its deadline and starts a new one", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    client.connect();
    const stuck = FakeSocket.last;
    jest.advanceTimersByTime(7_999);
    expect(FakeSocket.last).toBe(stuck);
    jest.advanceTimersByTime(1);
    // closed by the client itself, without waiting for a close event that may never come
    expect(stuck.readyState).toBe(3);
    expect(disconnects).toBe(1);
    jest.advanceTimersByTime(250);
    const retry = FakeSocket.last;
    expect(retry).not.toBe(stuck);
    // the late close event of the abandoned attempt changes nothing
    stuck.disconnect();
    expect(disconnects).toBe(1);
    retry.open();
    // an open connection has no deadline
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(retry);
    expect(retry.readyState).toBe(FakeSocket.OPEN);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("connects at once when the page wakes with a closed socket and no reconnect waiting", () => {
  const client = new HerdrSocket("ws://test/ws");
  let disconnects = 0;
  client.onDisconnect(() => { disconnects++; });
  client.connect();
  const frozen = FakeSocket.last;
  frozen.open();
  // the page froze: the socket died and its close event has not run, so no reconnect is scheduled
  frozen.close();
  client.wake();
  const woken = FakeSocket.last;
  expect(woken).not.toBe(frozen);
  expect(disconnects).toBe(1);
  // its close event arriving afterwards is the old connection's and ends nothing
  frozen.disconnect();
  expect(disconnects).toBe(1);
  // a socket still connecting is left to its own attempt
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  woken.open();
  // and an open one is left alone
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  expect(woken.readyState).toBe(FakeSocket.OPEN);
  client.close();
});

it("leaves a CLOSING socket to its close event on wake, so the server's output-stalled close still stops output", () => {
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.closing();
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
  expect(errors).toEqual(["output_stalled"]);
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  client.close();
});

it("still delivers a submit-result that arrives while a woken socket is closing", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "hello", "hello");
    const frame = await sent;
    socket.closing();
    client.wake();
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
  } finally {
    client.close();
  }
});

it("stops output when the late close event of a socket wake() already ended says output stalled", () => {
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  client.connect();
  const frozen = FakeSocket.last;
  frozen.open();
  // CLOSED with its close event still queued: wake ends it and starts a replacement
  frozen.close();
  client.wake();
  const replacement = FakeSocket.last;
  expect(replacement).not.toBe(frozen);
  replacement.open();
  frozen.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
  expect(errors).toEqual(["output_stalled"]);
  expect(replacement.readyState).toBe(3);
  expect(client.connected).toBe(false);
  // stopped: waking reconnects nothing, an attach does
  client.wake();
  expect(FakeSocket.last).toBe(replacement);
  client.attach("w1:p1", 80, 24);
  expect(FakeSocket.last).not.toBe(replacement);
  client.close();
});

it("lets a slow handshake connect: each attempt given up doubles the next deadline", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.connect();
    const first = FakeSocket.last;
    jest.advanceTimersByTime(8_000);
    expect(first.readyState).toBe(3);
    jest.advanceTimersByTime(250);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    // a remote PC's upgrade waits up to 15s for its relay: 12s is past the first deadline but inside the second
    jest.advanceTimersByTime(12_000);
    expect(FakeSocket.last).toBe(second);
    expect(second.readyState).toBe(FakeSocket.CONNECTING);
    second.open();
    expect(client.connected).toBe(true);
    // Opening starts the connect deadline over at 8s, not the backoff: this open was brief.
    second.disconnect();
    jest.advanceTimersByTime(500);
    const third = FakeSocket.last;
    expect(third).not.toBe(second);
    jest.advanceTimersByTime(8_000);
    expect(third.readyState).toBe(3);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** An attached, input-ready connection to a bridge listing `features`. */
function liveClient(features: string[]): { client: HerdrSocket; socket: FakeSocket } {
  const client = new HerdrSocket("ws://test/ws");
  client.attach("w1:p1", 100, 30);
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["input-ready", ...features]));
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  return { client, socket };
}
const pings = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "ping");

it("drops an open socket that answers no ping, reconnects at once and replays the attach", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    const result = client.submit("w1:p1", "sent before the wake", "sent before the wake");
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    expect(submissions(socket).map((frame) => frame.type)).toEqual(["submit"]);
    // the page comes back: the socket still reads OPEN, but its network is gone
    client.wake();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    expect(client.state).toBe("probing");
    expect(client.connected).toBe(true);
    // a slow link gets a second ping at the first deadline, and is dropped only when that one goes unanswered too
    jest.advanceTimersByTime(3_000);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    expect(FakeSocket.last).toBe(socket);
    jest.advanceTimersByTime(2_999);
    expect(FakeSocket.last).toBe(socket);
    jest.advanceTimersByTime(1);
    // given up without waiting for a close event, and a new attempt started without a backoff
    expect(socket.readyState).toBe(3);
    expect(disconnects).toBe(1);
    expect(await result).toMatchObject({ ok: false, code: "disconnected" });
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    expect(client.state).toBe("connecting");
    fresh.open();
    expect(fresh.sent).toEqual([{ type: "role", mode: "interact" }, { type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String) }]);
    expect(client.state).toBe("open");
    // the dead socket's late close changes nothing
    socket.disconnect();
    expect(disconnects).toBe(1);
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("gives up the reads still in flight when a connection found dead is replaced", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  const original = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  try {
    // a read that went out on the lost network, and one sent while the new connection was on its way
    void nativeTransport.fetch("/api/pane/conversation?pane_id=w1:p1");
    client.wake();
    jest.advanceTimersByTime(6_000);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    void nativeTransport.fetch("/api/health");
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    fresh.open();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    // a reconnect after a plain close gives up nothing
    void nativeTransport.fetch("/api/health");
    fresh.disconnect();
    jest.advanceTimersByTime(5_000);
    FakeSocket.last.open();
    expect(signals[2]!.aborted).toBe(false);
  } finally {
    globalThis.fetch = original;
    client.close();
    jest.useRealTimers();
  }
});

it("keeps typing out of the socket while a probe waits, and takes it again only when its pong comes back", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    expect(client.sendInput("w1:p1", "a")).toBe(true);
    // the typing's fence: the pong of a ping sent after it confirms the server read it (#2587)
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    client.wake();
    // refused, so PaneTerminal keeps the keys as a held draft
    expect(client.canInput("w1:p1")).toBe(false);
    expect(client.sendInput("w1:p1", "b")).toBe(false);
    expect(client.sendKeys("w1:p1", ["Enter"])).toBe(false);
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "a" }]);
    // a second wake while one waits sends no second ping
    client.wake();
    expect(pings(socket)).toHaveLength(2);
    // a frame the browser had buffered before the sleep, or a pong to no ping of the probe, proves nothing
    socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "idle" });
    socket.receive({ type: "pong", id: 99 });
    socket.receive({ type: "pong", id: 1 });
    expect(client.state).toBe("probing");
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive({ type: "pong", id: 2 });
    expect(client.state).toBe("open");
    expect(client.sendInput("w1:p1", "c")).toBe(true);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(socket);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("holds typing the socket took when its connection ends before the server confirmed it (#2587)", () => {
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    expect(client.sendInput("w1:p1", "ec")).toBe(true);
    expect(client.sendInput("w1:p1", "ho")).toBe(true);
    // one fence at a time, however fast the typing: "ho" waits for the next
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    socket.receive({ type: "pong", id: 1 });
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    // typed at a masked prompt: never kept, so never held
    expect(client.sendInput("w1:p1", "hunter2", false, false, true)).toBe(true);
    expect(client.sendInput("w1:p1", "\x7f")).toBe(true);
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual([]);
    socket.disconnect();
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual(["ho", "\x7f"]);
    // given once
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally {
    client.close();
  }
});

it("holds typing a bridge with input-receipt read but did not confirm typing when its connection ends (#2677)", () => {
  const { client, socket } = liveClient(["submit", "ping", "input-receipt"]);
  try {
    expect(client.sendInput("w1:p1", "ls")).toBe(true);
    expect(client.sendInput("w1:p1", " -la")).toBe(true);
    expect(client.sendInput("w1:p1", "x")).toBe(true);
    expect(client.sendInput("w1:p1", "\x1b[0n", false, true)).toBe(true);
    expect(submissions(socket)).toEqual([
      { type: "input", pane_id: "w1:p1", text: "ls", id: 1 },
      { type: "input", pane_id: "w1:p1", text: " -la", id: 2 },
      { type: "input", pane_id: "w1:p1", text: "x", id: 3 },
      { type: "input", pane_id: "w1:p1", text: "\x1b[0n", automatic: true },
    ]);
    // receipts need no fence, and a pong proves only that the bridge read the frames
    expect(pings(socket)).toEqual([]);
    socket.receive({ type: "pong", id: 1 });
    socket.receive({ type: "input-result", id: 1, pane_id: "w1:p1", ok: true });
    // a refusal is told by its error frame, not held
    socket.receive({ type: "input-result", id: 3, pane_id: "w1:p1", ok: false, code: "input_failed" });
    // another pane's receipt confirms nothing here
    socket.receive({ type: "input-result", id: 2, pane_id: "w1:p2", ok: true });
    socket.disconnect();
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual([" -la"]);
  } finally {
    client.close();
  }
});

it("waits for the receipt of typing sent before a bridge with input-receipt said what it takes (#2677)", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.trustFeatures(() => false);
  client.attach("w1:p1", 80, 24);
  client.connect();
  const socket = FakeSocket.last;
  try {
    socket.open();
    socket.receive({ type: "features", features: ["input-ready", "ping", "input-receipt"], connection: "c1", herdr_lifetime: "replaced" });
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.sendInput("w1:p1", "echo early")).toBe(true);
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "echo early", id: 1 }]);
    socket.receive(snapshot(["input-ready", "ping", "input-receipt"]));
    expect(pings(socket)).toEqual([]);
    socket.receive({ type: "pong", id: 1 });
    socket.disconnect();
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual(["echo early"]);
  } finally {
    client.close();
  }
});

it("keeps typing sent before the bridge said what it takes, and fences it once it says so", () => {
  const start = () => {
    const client = new HerdrSocket("ws://test/ws");
    // a features frame naming another herdr is not trusted: what the bridge takes waits for the snapshot
    client.trustFeatures(() => false);
    client.attach("w1:p1", 80, 24);
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({ type: "features", features: ["input-ready", "ping"], connection: "c1", herdr_lifetime: "replaced" });
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.sendInput("w1:p1", "echo early")).toBe(true);
    return { client, socket };
  };
  const dropped = start();
  try {
    dropped.socket.disconnect();
    expect(dropped.client.takeUnconfirmedInput("w1:p1")).toEqual(["echo early"]);
  } finally { dropped.client.close(); }
  const fenced = start();
  try {
    expect(pings(fenced.socket)).toEqual([]);
    fenced.socket.receive(snapshot(["input-ready", "ping"]));
    expect(pings(fenced.socket)).toEqual([{ type: "ping", id: 1 }]);
    fenced.socket.receive({ type: "pong", id: 1 });
    fenced.socket.disconnect();
    expect(fenced.client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally { fenced.client.close(); }
  // an older bridge answers no ping: its snapshot releases the typing, trusted as before
  const older = start();
  try {
    older.socket.receive(snapshot(["input-ready"]));
    expect(pings(older.socket)).toEqual([]);
    older.socket.disconnect();
    expect(older.client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally { older.client.close(); }
});

it("keeps a pane's unconfirmed typing across a second drop until its terminal takes it", () => {
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    expect(client.sendInput("w1:p1", "echo a")).toBe(true);
    // no terminal of the pane is mounted to take it: the reconnect drops before one is
    socket.disconnect();
    client.wake();
    const again = FakeSocket.last;
    expect(again).not.toBe(socket);
    again.open();
    again.receive(snapshot(["input-ready", "submit", "ping"]));
    again.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.sendInput("w1:p1", " b")).toBe(true);
    again.disconnect();
    // older typing stays ahead of newer
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual(["echo a", " b"]);
  } finally {
    client.close();
  }
});

it("never offers typing lost on one herdr to a pane of another that reuses its ID", () => {
  const proven = (socket: FakeSocket, lifetime: string) => socket.receive({ type: "snapshot", snapshot: { workspaces: [], panes: [], agents: [], layouts: [], herdr_lifetime: lifetime }, features: ["input-ready", "ping"] });
  const lostOn = (lifetime: string) => {
    const client = new HerdrSocket("ws://test/ws");
    client.attach("w1:p1", 80, 24);
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    proven(socket, lifetime);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.sendInput("w1:p1", "rm -rf build")).toBe(true);
    // no terminal of the pane is mounted to take it, and the connection comes back
    socket.disconnect();
    client.wake();
    const again = FakeSocket.last;
    again.open();
    // a new connection that has not said which herdr it reads keeps the typing back
    expect(client.takeUnconfirmedInput("w1:p1")).toEqual([]);
    return { client, again };
  };
  const replaced = lostOn("herdr-a");
  try {
    proven(replaced.again, "herdr-b");
    expect(replaced.client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally { replaced.client.close(); }
  const same = lostOn("herdr-a");
  try {
    proven(same.again, "herdr-a");
    expect(same.client.takeUnconfirmedInput("w1:p1")).toEqual(["rm -rf build"]);
  } finally { same.client.close(); }
});

it("holds nothing the server confirmed, a probe's pong included, nor anything typed to an older bridge", () => {
  jest.useFakeTimers();
  const live = liveClient(["submit", "ping"]);
  try {
    expect(live.client.sendInput("w1:p1", "a")).toBe(true);
    live.client.wake();
    // the probe's ping went after the typing: its pong confirms it as the fence's would
    live.socket.receive({ type: "pong", id: 2 });
    live.socket.disconnect();
    expect(live.client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally {
    live.client.close();
    jest.useRealTimers();
  }
  const older = liveClient(["submit"]);
  try {
    expect(older.client.sendInput("w1:p1", "a")).toBe(true);
    expect(pings(older.socket)).toEqual([]);
    older.socket.disconnect();
    expect(older.client.takeUnconfirmedInput("w1:p1")).toEqual([]);
  } finally {
    older.client.close();
  }
});

it("drops a socket whose only frames during a probe are stale ones", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    for (let step = 0; step < 6; step++) {
      socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "idle" });
      jest.advanceTimersByTime(1_000);
    }
    expect(FakeSocket.last).not.toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** Lets the client's async submit paths run up to their next real wait. */
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

it("holds a submit, a pending action and a secret until the probe's pong, then sends each once", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "pending-input", "secret-input", "ping"]);
  try {
    client.wake();
    const submit = client.submit("w1:p1", "later", "later");
    const steer = client.pendingAction("w1:p1", "pending-1", "steer");
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2", () => true);
    // waiting, not offline: the composer keeps its text and does not say the PC is gone
    expect(submit).not.toBeNull();
    expect(steer).not.toBeNull();
    expect(secret).not.toBeNull();
    await settle();
    const requests = () => socket.sent.filter((frame) => ["submit", "pending-action", "secret"].includes(frame.type));
    expect(requests()).toEqual([]);
    socket.receive({ type: "pong", id: 1 });
    await settle();
    expect(requests().map((frame) => frame.type)).toEqual(["submit", "pending-action", "secret"]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("settles a submit that waited on a probe as not transmitted when the socket is dropped, having sent nothing", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "secret-input", "ping"]);
  try {
    // a submit already on its way when the page comes back, still before its snapshot wait ends
    const submit = client.submit("w1:p1", "later", "later");
    client.wake();
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2", () => true);
    await settle();
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(socket);
    expect(await submit).toMatchObject({ ok: false, code: "not_transmitted" });
    expect(await secret).toMatchObject({ ok: false, code: "disconnected" });
    expect(socket.sent.filter((frame) => ["submit", "secret"].includes(frame.type))).toEqual([]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("probes a socket that has said nothing since a submit left, without waiting for the idle check", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    void client.submit("w1:p1", "hello", "hello");
    await settle();
    expect(socket.sent.filter((frame) => frame.type === "submit")).toHaveLength(1);
    jest.advanceTimersByTime(3_000);
    expect(socket.sent.filter((frame) => frame.type === "ping")).toHaveLength(1);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("leaves a silent submit to the page being shown again when it was hidden meanwhile", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    void client.submit("w1:p1", "hello", "hello");
    await settle();
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    jest.advanceTimersByTime(3_000);
    expect(socket.sent.filter((frame) => frame.type === "ping")).toEqual([]);
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(socket.sent.filter((frame) => frame.type === "ping")).toHaveLength(1);
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("does not probe after a submit when the socket has answered meanwhile", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    void client.submit("w1:p1", "hello", "hello");
    await settle();
    jest.advanceTimersByTime(1_000);
    socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "working" });
    jest.advanceTimersByTime(2_000);
    expect(socket.sent.filter((frame) => frame.type === "ping")).toEqual([]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("still stops output on a 4008 close that comes after a probe dropped the socket", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const errors: string[] = [];
    client.on((message) => { if (message.type === "error") errors.push(message.code); });
    client.wake();
    jest.advanceTimersByTime(6_000);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    fresh.open();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    expect(client.state).toBe("stopped");
    expect(fresh.readyState).toBe(3);
    expect(client.connected).toBe(false);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("does not drop a connection over a probe deadline that ran out while the page was frozen", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    // the page froze for a minute: the timers fire at once on resume, before the queued pong is read
    jest.setSystemTime(Date.now() + 60_000);
    jest.advanceTimersByTime(3_000);
    expect(FakeSocket.last).toBe(socket);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    // the pong to the ping sent before the freeze no longer counts; the fresh one does
    socket.receive({ type: "pong", id: 1 });
    expect(client.state).toBe("probing");
    socket.receive({ type: "pong", id: 2 });
    expect(client.state).toBe("open");
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("pauses a probe when the page is hidden and pings again when it is shown", () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    // a probe cut short is not an answer: typing stays refused until a pong comes
    expect(client.state).toBe("probing");
    expect(client.canInput("w1:p1")).toBe(false);
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(socket);
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    socket.receive({ type: "pong", id: 2 });
    expect(client.state).toBe("open");
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("probes a reconnected socket whose snapshot never came, on a bridge that listed ping before", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    fresh.open();
    client.wake();
    expect(pings(fresh)).toHaveLength(1);
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(fresh);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("tells its handlers the probe's pong, so a view that read input as refused during the probe reads it again", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const seen: boolean[] = [];
    client.on((message) => { seen.push(message.type === "pong" && client.canInput("w1:p1")); });
    client.wake();
    // output during the probe: a view reading canInput() now stores false
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "x" });
    expect(seen).toEqual([false]);
    socket.receive({ type: "pong", id: 1 });
    expect(seen).toEqual([false, true]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ends a probe sent before the snapshot when the reconnected bridge does not list ping, and keeps its connection", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const older = FakeSocket.last;
    expect(older).not.toBe(socket);
    older.open();
    // woken before the new snapshot: the ping support remembered from the last bridge sends a ping
    client.wake();
    expect(pings(older)).toHaveLength(1);
    const submit = client.submit("w1:p1", "later", "later");
    older.receive(snapshot(["submit"]));
    expect(client.state).toBe("open");
    await settle();
    expect(older.sent.filter((frame) => frame.type === "submit").map((frame) => frame.text)).toEqual(["later"]);
    older.receive({ type: "submit-result", id: older.sent.find((frame) => frame.type === "submit")!.id, pane_id: "w1:p1", ok: true });
    expect(await submit).toEqual({ ok: true });
    jest.advanceTimersByTime(30_000);
    expect(FakeSocket.last).toBe(older);
    expect(older.readyState).toBe(FakeSocket.OPEN);
    expect(pings(older)).toHaveLength(1);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ends a probe the hidden page paused when the reconnected bridge's snapshot does not list ping", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const older = FakeSocket.last;
    older.open();
    client.wake();
    expect(pings(older)).toHaveLength(1);
    // put away before the snapshot: the probe pauses
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    expect(client.state).toBe("probing");
    const submit = client.submit("w1:p1", "later", "later");
    older.receive(snapshot(["submit"]));
    // shown again: probe() never pings this bridge, so the snapshot must have ended the paused probe
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(client.state).toBe("open");
    await settle();
    expect(older.sent.filter((frame) => frame.type === "submit").map((frame) => frame.text)).toEqual(["later"]);
    older.receive({ type: "submit-result", id: older.sent.find((frame) => frame.type === "submit")!.id, pane_id: "w1:p1", ok: true });
    expect(await submit).toEqual({ ok: true });
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("doubles the probe deadline after a probe drop, and starts over once a pong comes back", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    jest.advanceTimersByTime(6_000);
    const second = FakeSocket.last;
    expect(second).not.toBe(socket);
    second.open();
    second.receive(snapshot(["ping"]));
    client.wake();
    // 6s per ping now: a link that is just slow is not dropped again at the same deadline
    jest.advanceTimersByTime(11_999);
    expect(FakeSocket.last).toBe(second);
    expect(pings(second)).toHaveLength(2);
    second.receive({ type: "pong", id: pings(second).at(-1)!.id as number });
    expect(client.state).toBe("open");
    client.wake();
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(second);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("pings a connection silent for 20s while visible, and not one that keeps receiving", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    for (let second = 0; second < 60; second += 5) {
      jest.advanceTimersByTime(5_000);
      socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "working" });
    }
    expect(pings(socket)).toEqual([]);
    jest.advanceTimersByTime(19_999);
    expect(pings(socket)).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("never pings a bridge whose snapshot does not list ping, and trusts its connection as before", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit"]);
  try {
    client.wake();
    jest.advanceTimersByTime(120_000);
    expect(pings(socket)).toEqual([]);
    expect(FakeSocket.last).toBe(socket);
    expect(client.state).toBe("open");
    expect(client.sendInput("w1:p1", "x")).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("leaves a socket the server is closing to its close event when a probe times out, so a 4008 still stops output", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const errors: string[] = [];
    client.on((message) => { if (message.type === "error") errors.push(message.code); });
    client.wake();
    socket.closing();
    jest.advanceTimersByTime(3_000);
    expect(FakeSocket.last).toBe(socket);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    expect(client.state).toBe("stopped");
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("keeps a submit and a secret waiting when the page hides during a probe, and sends them after the next pong", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["submit", "secret-input", "ping"]);
  try {
    client.wake();
    const submit = client.submit("w1:p1", "later", "later");
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2", () => true);
    await settle();
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    await settle();
    const requests = () => socket.sent.filter((frame) => ["submit", "secret"].includes(frame.type));
    // nothing goes out on a socket no pong has vouched for
    expect(requests()).toEqual([]);
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    await settle();
    expect(requests()).toEqual([]);
    socket.receive({ type: "pong", id: 2 });
    await settle();
    expect(requests().map((frame) => frame.type)).toEqual(["submit", "secret"]);
    expect(submit).not.toBeNull();
    expect(secret).not.toBeNull();
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("settles a submit waiting on a probe when a CLOSING socket is replaced, and takes input on the new one", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    client.wake();
    let outcome: unknown = null;
    void client.submit("w1:p1", "later", "later")!.then((result) => { outcome = result; });
    await settle();
    // the closing handshake started, and a pane mount connects again before the close event
    socket.closing();
    client.connect();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    await settle();
    expect(outcome).toMatchObject({ ok: false, code: "not_transmitted" });
    expect(disconnects).toBe(1);
    fresh.open();
    fresh.receive(snapshot(["input-ready", "submit", "ping"]));
    fresh.receive({ type: "input-ready", pane_id: "w1:p1" });
    // the old probe's deadline does not hold the new socket's input
    expect(client.canInput("w1:p1")).toBe(true);
    jest.advanceTimersByTime(12_000);
    expect(FakeSocket.last).toBe(fresh);
    expect(socket.sent.filter((frame) => frame.type === "submit")).toEqual([]);
    // its late close changes nothing
    socket.closeEvent(1000);
    expect(disconnects).toBe(1);
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("gives up an attempt with a grown deadline on wake and starts a fresh one with the shortest", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.connect();
    const first = FakeSocket.last;
    jest.advanceTimersByTime(8_000 + 250);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    jest.advanceTimersByTime(16_000 + 500);
    const third = FakeSocket.last;
    expect(third).not.toBe(second);
    // the network comes back 2s into an attempt whose deadline has grown to 30s
    jest.advanceTimersByTime(2_000);
    expect(third.readyState).toBe(FakeSocket.CONNECTING);
    client.wake();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(third);
    expect(third.readyState).toBe(3);
    // the fresh attempt's deadline is 8s again
    jest.advanceTimersByTime(8_000);
    expect(fresh.readyState).toBe(3);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("never reconnects from a backoff retry left pending once the server stopped output", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  try {
    client.connect();
    // failed attempts back the retry off to 4s
    for (const delay of [250, 500, 1_000, 2_000]) {
      FakeSocket.last.disconnect();
      jest.advanceTimersByTime(delay);
    }
    const failing = FakeSocket.last;
    failing.disconnect();
    // a pane mounts and connects before that retry runs
    client.connect();
    const replacement = FakeSocket.last;
    expect(replacement).not.toBe(failing);
    replacement.open();
    replacement.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(replacement);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** A page whose visibility the test sets: install it before connect(), which listens for its changes. */
function fakePage(): { hide(): void; show(): void; restore(): void } {
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const change = (state: string) => { page.visibilityState = state; listeners.get("visibilitychange")?.(); };
  return { hide: () => change("hidden"), show: () => change("visible"), restore: () => { globalDocument.document = previous; } };
}

it("marks a 4008 that came while the page was hidden, and an attach after it is shown reconnects and replays every attach", () => {
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    client.attach("w1:p2", 80, 24);
    page.hide();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(true);
    // showing the page reconnects nothing by itself: the pane, back in use, attaches again
    page.show();
    expect(FakeSocket.last).toBe(socket);
    client.attach("w1:p1", 100, 30);
    expect(client.outputStopped).toBe(false);
    expect(client.stoppedWhileHidden).toBe(false);
    const reconnected = FakeSocket.last;
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    expect(reconnected.sent.filter((frame) => frame.type === "attach").map((frame) => frame.pane_id).sort()).toEqual(["w1:p1", "w1:p2"]);
  } finally {
    client.close();
    page.restore();
  }
});

it("counts a 4008 read just after the page is shown again as the hidden page's, once", () => {
  jest.useFakeTimers();
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    page.hide();
    page.show();
    // the frozen page reads the server's close only after it resumed
    jest.advanceTimersByTime(1_000);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.stoppedWhileHidden).toBe(true);
    client.attach("w1:p1", 100, 30);
    const reconnected = FakeSocket.last;
    reconnected.open();
    // the same device stalls again while in use: that stop is final
    reconnected.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(false);
  } finally {
    client.close();
    page.restore();
    jest.useRealTimers();
  }
});

it("keeps a 4008 while the page is in use final: no reconnect on its own, on wake or later", () => {
  jest.useFakeTimers();
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    page.hide();
    page.show();
    // long after the page came back, this device is simply too slow
    jest.advanceTimersByTime(60_000);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(false);
    client.wake();
    page.hide();
    page.show();
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(socket);
    expect(client.state).toBe("stopped");
  } finally {
    client.close();
    page.restore();
    jest.useRealTimers();
  }
});

it("counts a page that connected while hidden as put away until it is first shown", () => {
  const page = fakePage();
  page.hide();
  const { client, socket } = liveClient([]);
  try {
    page.show();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.stoppedWhileHidden).toBe(true);
  } finally {
    client.close();
    page.restore();
  }
});

it("ends the connection when the page is left, and connects again only when it is shown", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit"]);
  let disconnects = 0;
  client.onDisconnect(() => { disconnects++; });
  try {
    // a page kept in the back/forward cache would keep this socket open behind its replacement
    globalThis.dispatchEvent(new Event("pagehide"));
    expect(socket.readyState).toBe(3);
    expect(disconnects).toBe(1);
    expect(client.connected).toBe(false);
    expect(client.canInput("w1:p1")).toBe(false);
    // its close event arms no retry behind the page
    socket.closeEvent(1001);
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(socket);
    // nor does the network coming back, or a pane attaching, in the moment before the page freezes
    globalThis.dispatchEvent(new Event("online"));
    client.connect();
    expect(FakeSocket.last).toBe(socket);
    globalThis.dispatchEvent(new Event("pageshow"));
    const next = FakeSocket.last;
    expect(next).not.toBe(socket);
    next.open();
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** Capture metadata only, retaining the actual socket/lifecycle code and its context callback. */
const traceGlobals = globalThis as unknown as { document?: unknown; fetch?: unknown };
const traceBefore = { document: traceGlobals.document, fetch: traceGlobals.fetch };
afterEach(() => { traceGlobals.document = traceBefore.document; traceGlobals.fetch = traceBefore.fetch; });

function tracedClient(features: string[]) {
  const reports: ClientConnectionTrace[] = [];
  // The public browser transport: a document makes the trace POST through window.fetch (here the global).
  traceGlobals.document = { createElement() {}, visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  traceGlobals.fetch = async (_url: string, init: RequestInit) => { reports.push(JSON.parse(init.body as string)); return new Response(null, { status: 204 }); };
  const client = new HerdrSocket("ws://test/ws?machine_id=local");
  client.connect();
  const socket = FakeSocket.last;
  socket.open(); socket.receive(snapshot(features));
  return { client, socket, reports };
}

it("records the missed-heartbeat path and distinguishes a late old-socket close, without replaying input", async () => {
  jest.useFakeTimers();
  const { client, socket, reports } = tracedClient(["ping", "submit"]);
  try {
    client.wake();
    jest.advanceTimersByTime(3000);
    expect(reports[0]!.events.map((event) => event.kind)).toContain("probe_retry");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(3000);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    fresh.open(); fresh.receive(snapshot(["ping", "submit"]));
    jest.advanceTimersByTime(10_000);
    socket.closeEvent(1005);
    expect(reports.at(-1)!.events.at(-1)).toMatchObject({ kind: "close", connection: 1, socket_state: 3, code: 1005 });
    expect(reports.at(-1)!.events.map((event) => event.kind)).toContain("probe_drop");
    expect(submissions(fresh)).toEqual([]);
  } finally { client.close(); jest.useRealTimers(); }
});

it("records pagehide versus a send receipt interruption without retaining the message or resending it", async () => {
  jest.useFakeTimers();
  const { client, socket, reports } = tracedClient(["submit"]);
  try {
    const frame = socket.nextSubmission();
    const pending = client.submit("private-pane", "private-message", "private-payload")!;
    await frame;
    (client as unknown as { onLeave(): void }).onLeave();
    expect(await pending).toMatchObject({ ok: false, code: "disconnected" });
    expect(reports[0]!.events.at(-1)).toMatchObject({ kind: "pagehide", pending: 1 });
    expect(reports[0]!.events.map((event) => event.kind)).toContain("submit_sent");
    expect(JSON.stringify(reports)).not.toContain("private-");
    (client as unknown as { onWake(event: Event): void }).onWake(new Event("pageshow"));
    const fresh = FakeSocket.last; fresh.open(); fresh.receive(snapshot(["submit"]));
    expect(submissions(fresh)).toEqual([]);
  } finally { client.close(); jest.useRealTimers(); }
});

it("records a socket stuck closing without forcing a new connection or bypassing authority", () => {
  jest.useFakeTimers();
  const { client, socket, reports } = tracedClient(["ping"]);
  try {
    socket.closing();
    jest.advanceTimersByTime(5000);
    expect(reports[0]!.events.at(-1)).toMatchObject({ kind: "closing_wait", socket_state: 2 });
    expect(FakeSocket.last).toBe(socket);
    expect(client.sendInput("w1:p1", "private-draft")).toBe(false);
  } finally { client.close(); jest.useRealTimers(); }
});

it("records an unanswered submit deadline without its input or an automatic retry", async () => {
  jest.useFakeTimers();
  const { client, socket, reports } = tracedClient(["submit"]);
  try {
    const frame = socket.nextSubmission();
    const result = client.submit("private-pane", "private-message", "private-payload")!;
    const sent = await frame;
    jest.advanceTimersByTime(90_000);
    expect(await result).toMatchObject({ ok: false, code: "timeout" });
    expect(reports[0]!.events.at(-1)).toMatchObject({ kind: "submit_timeout", request_id: sent.id });
    expect(JSON.stringify(reports)).not.toContain("private-");
    expect(submissions(socket)).toHaveLength(1);
  } finally { client.close(); jest.useRealTimers(); }
});

it("records actual probe-blocked input once, not readiness polling or the text/chord", () => {
  jest.useFakeTimers();
  const { client, socket, reports } = tracedClient(["ping", "input-ready"]);
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: true });
    expect(client.canInput("w1:p1")).toBe(true);
    client.wake();
    for (let i = 0; i < 100; i++) expect(client.canInput("w1:p1")).toBe(false);
    expect(reports).toHaveLength(0);
    expect(client.sendInput("w1:p1", "private-typed-text")).toBe(false);
    expect(client.sendKeys("w1:p1", ["private-chord"])).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.events.at(-1)).toMatchObject({ kind: "probe_input_blocked", socket_state: 1 });
    expect(JSON.stringify(reports)).not.toContain("private-");
    expect(submissions(socket)).toEqual([]);
    socket.receive({ type: "pong", id: pings(socket).at(-1)!.id });
    expect(client.canInput("w1:p1")).toBe(true);
  } finally { client.close(); jest.useRealTimers(); }
});

// ---- insert without Enter (feature "terminal-insert") ----------------------------------------

/** every frame the client sent that could carry text into the pane */
const inputs = (socket: FakeSocket) => socket.sent.filter((frame) => ["insert", "submit", "input", "keys"].includes(frame.type));

it("insert waits for matching acknowledgement", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "terminal-insert"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    const frame = new Promise<{ id: number }>((resolve) => socket.addEventListener("sent", (sent) => { if (sent.type === "insert") resolve(sent); }));
    const result = client.insert("w1:p1", "git status")!;
    let settled = false;
    void result.then(() => { settled = true; });
    const sent = await frame;
    expect(inputs(socket)).toEqual([{ type: "insert", id: sent.id, pane_id: "w1:p1", text: "git status" }]);
    // another pane's answer, another request's answer, and a submit's answer with this id say nothing about it
    socket.receive({ type: "insert-result", id: sent.id, pane_id: "w1:p2", ok: true });
    socket.receive({ type: "insert-result", id: sent.id + 1, pane_id: "w1:p1", ok: true });
    socket.receive({ type: "submit-result", id: sent.id, pane_id: "w1:p1", ok: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive({ type: "insert-result", id: sent.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
    // a refusal comes back as it was said, and no Enter or input follows it
    const refused = client.insert("w1:p1", "line one\rline two")!;
    const second = await new Promise<{ id: number }>((resolve) => socket.addEventListener("sent", (sent) => { if (sent.type === "insert" && sent.text === "line one\rline two") resolve(sent); }));
    socket.receive({ type: "insert-result", id: second.id, pane_id: "w1:p1", ok: false, code: "unsafe_multiline", message: "no paste mode" });
    expect(await refused).toEqual({ ok: false, code: "unsafe_multiline", message: "no paste mode" });
    expect(inputs(socket)).toHaveLength(2);
  } finally { client.close(); }
});

it("old bridge sends nothing", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // a bridge that submits but does not insert: no input or submit stands in for the insert
  socket.receive(snapshot(["submit", "input-ready"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(await client.insert("w1:p1", "git status")).toMatchObject({ ok: false, code: "unsupported" });
    expect(inputs(socket)).toEqual([]);
    expect(client.canInsert()).toBe(false);
  } finally { client.close(); }
});

it("disconnect never replays insert", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "terminal-insert"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    const frame = new Promise<{ id: number }>((resolve) => socket.addEventListener("sent", (sent) => { if (sent.type === "insert") resolve(sent); }));
    const result = client.insert("w1:p1", "rm -rf build")!;
    await frame;
    socket.disconnect();
    // not confirmed, never "sent": the draft stays with its uncertainty, and nothing is queued
    expect(await result).toMatchObject({ ok: false, code: "disconnected" });
    // the reconnect replays the role and the attach, never the insert
    client.wake();
    const next = FakeSocket.last;
    expect(next).not.toBe(socket);
    next.open();
    next.receive(snapshot(["submit", "input-ready", "terminal-insert"]));
    next.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(inputs(next)).toEqual([]);
    expect(next.sent.map((sent) => sent.type)).toEqual(["role", "attach"]);
    // a late answer to the old request on the new connection settles nothing and sends nothing
    next.receive({ type: "insert-result", id: 1, pane_id: "w1:p1", ok: true });
    expect(inputs(next)).toEqual([]);
    // disconnected, an insert goes nowhere at all: null, like a submit
    next.disconnect();
    expect(client.insert("w1:p1", "again")).toBeNull();
  } finally { client.close(); }
});

it("an insert waiting on a probe is dropped when the pane's input changed meanwhile", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "terminal-insert", "ping"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    client.wake();
    const result = client.insert("w1:p1", "rm -rf build")!;
    // the pane loses its input and gets it back (a detach and reattach) before the pong comes back
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    socket.receive({ type: "pong", id: pings(socket).at(-1)!.id });
    expect(await result).toMatchObject({ ok: false, code: "input_not_ready" });
    expect(socket.sent.filter((frame) => frame.type === "insert")).toEqual([]);
  } finally { client.close(); }
});

it("an input lease changes with every readiness or role of the pane's connection, even one that came back", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "terminal-insert"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    const first = client.inputLease("w1:p1");
    // the pane's output, and another pane's readiness, leave it alone
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "$ " });
    socket.receive({ type: "input-ready", pane_id: "w1:p2" });
    expect(client.inputLease("w1:p1")).toBe(first);
    // readiness lost and given back: ready as before, but another lease
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    const cycled = client.inputLease("w1:p1");
    expect(cycled).not.toBe(first);
    // a held attach that let go, and a role that went and came back
    socket.receive({ type: "error", code: "attach_held", message: "held", pane_id: "w1:p1" });
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    const released = client.inputLease("w1:p1");
    expect(released).not.toBe(cycled);
    socket.receive({ type: "role-ack", mode: "observe" });
    socket.receive({ type: "role-ack", mode: "interact" });
    expect(client.inputLease("w1:p1")).not.toBe(released);
  } finally { client.close(); }
});

it("an observing connection and a liveness probe never carry an insert", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready", "terminal-insert", "ping"]));
  try {
    client.attach("w1:p1", 80, 24);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    client.setMode("observe");
    socket.receive({ type: "role-ack", mode: "observe" });
    expect(client.insert("w1:p1", "text")).toBeNull();
    client.setMode("interact");
    socket.receive({ type: "role-ack", mode: "interact" });
    // a probe in flight: the insert waits for the pong, and a drop ends it as not transmitted
    client.wake();
    const result = client.insert("w1:p1", "text")!;
    await Promise.resolve();
    expect(inputs(socket)).toEqual([]);
    socket.receive({ type: "pong", id: pings(socket).at(-1)!.id });
    const sent = await new Promise<{ id: number }>((resolve) => socket.addEventListener("sent", (frame) => { if (frame.type === "insert") resolve(frame); }));
    socket.receive({ type: "insert-result", id: sent.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
  } finally { client.close(); }
});

// #511: a message for an agent alone goes only to a bridge that refuses it where no agent runs
it("refuses an agent-only message on a bridge without agent-only, and names it where the bridge has it", async () => {
  for (const features of [["submit"], ["submit", "agent-only"]]) {
    const client = new HerdrSocket("ws://test/ws");
    client.connect();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive(snapshot(features));
    try {
      if (!features.includes("agent-only")) {
        expect(await client.submit("w1:p1", "> q\nc", "> q\rc", false, "immediate", undefined, false, undefined, undefined, true))
          .toMatchObject({ ok: false, code: "agent_only_unsupported" });
        expect(submissions(socket)).toEqual([]);
      } else {
        const next = socket.nextSubmission();
        void client.submit("w1:p1", "> q\nc", "> q\rc", false, "immediate", undefined, false, undefined, undefined, true);
        expect(await next).toMatchObject({ type: "submit", agent_only: true });
      }
    } finally {
      client.close();
    }
  }
});

it("runs on a transport's socket where the page has no global WebSocket", () => {
  // Given a transport that opens its own socket and no browser WebSocket global
  setTransport({ ...nativeTransport, kind: "relay", openSocket: (url) => new FakeSocket(url) as unknown as WebSocketLike });
  globals.WebSocket = undefined;
  const client = new HerdrSocket("ws://test/ws");
  try {
    // When it connects, opens and is woken
    client.connect();
    const socket = FakeSocket.last;
    expect(client.connected).toBe(false);
    socket.open();
    client.wake();
    // Then its ready state is read from the socket, not the missing global
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    globals.WebSocket = FakeSocket;
    setTransport(nativeTransport);
  }
});

it("forgets machine event capability on disconnect before a replacement subscriber can observe it", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect(); const socket = FakeSocket.last; socket.open();
  socket.receive({ type: "features", features: ["machine-events"], connection: "c" });
  expect(client.machineEventsAvailable).toBe(true);
  client.setMachineEvents(true);
  expect(socket.sent.filter((frame) => frame.type === "machine-events")).toEqual([{ type: "machine-events", enabled: true }]);
  socket.disconnect();
  expect(client.machineEventsAvailable).toBeNull();
  client.close();
});
