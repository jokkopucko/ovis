import { expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import { DeviceStore } from "../devices.ts";
import type { MachineRelay } from "../machine-relay.ts";
import { LARGE_REPLY_BYTES } from "../herdr/client.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_JOIN_BYTES_PER_SECOND, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "../output-window.ts";
import type { PendingInputs } from "../pending-input.ts";
import type { MachineEventDocument } from "../machine-events.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { SharedPreferences } from "../../shared/preferences.ts";
import { backlog, type Client, connectionData, connectionOf, createConnections, send, setMachineEvents } from "./connections.ts";

function harness({ deviceId, readOnly = false, relay, revokedAlready = false, store, machineEvents, open = false }: { deviceId?: string; readOnly?: boolean; relay?: MachineRelay; revokedAlready?: boolean; store?: DeviceStore; open?: boolean; machineEvents?: MachineEventDocument } = {}) {
  const log: string[] = [];
  const revocations: (() => void)[] = [];
  const devices = store ?? {
    onRevoke: (_id: string, close: () => void) => {
      if (revokedAlready) close(); else revocations.push(close);
      return () => log.push("unwatch device");
    },
    canDrive: () => true,
  } as unknown as DeviceStore;
  const pending = { close: () => log.push("pending closed") } as unknown as PendingInputs<Client, never>;
  const client = {
    data: connectionData({ deviceId, readOnly, ...(relay ? { relay } : {}), ...(machineEvents ? { machineEvents } : {}), ...(open ? { open: true } : {}) }),
    readyState: WebSocket.OPEN,
    close: (code?: number, reason?: string) => log.push(`closed ${code} ${reason}`),
    getBufferedAmount: () => 0,
    send: () => 1,
  };
  const clients = new Set<Client>([client]);
  const present = new Set<Client>([client]);
  const connections = createConnections({
    clients, present, pending, devices,
    detachClaimed: () => log.push("detach claimed"),
    dropClaims: () => log.push("drop claims"),
  });
  return { client, clients, present, log, revoke: () => revocations.forEach((close) => close()), ...connections };
}

/**
 * A connection whose observe processes are stand-ins: `kill` only asks one to end, and it has exited once `exit`
 * is called, as a real process ends some time after its signal. `started`: every process started, in order.
 */
function watching() {
  const started: Array<{ paneId: string; cols: number; killed: number; exit: () => Promise<void>; end: () => void }> = [];
  const frames: { type: string; code?: string; pane_id?: string; message?: string }[] = [];
  /** the next process cannot be started */
  const next = { fails: false };
  const client: Client = {
    data: connectionData({ deviceId: undefined, readOnly: true }), readyState: WebSocket.OPEN, close() {}, getBufferedAmount: () => 0,
    send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; },
  };
  const connections = createConnections({
    clients: new Set<Client>([client]), present: new Set<Client>([client]),
    pending: { close() {} } as unknown as PendingInputs<Client, never>, devices: {} as unknown as DeviceStore,
    detachClaimed() {}, dropClaims() {},
    startWatch: ({ paneId, cols, onEnd }) => {
      if (next.fails) { next.fails = false; throw new Error("no process could be started"); }
      const { promise, resolve } = Promise.withResolvers<void>();
      const process = { paneId, cols, killed: 0, end: onEnd, exit: async () => { resolve(); await promise; await Promise.resolve(); } };
      started.push(process);
      return { kill: () => { process.killed++; }, exited: promise };
    },
  });
  return { started, frames, client, next, ...connections };
}
const GRID = { cols: 80, rows: 24 };

it("holds no more than 64 observe processes for one connection, and ends the view of a pane past them at once", async () => {
  const w = watching();
  // each watch is a `herdr terminal session observe` process with three descriptors: a page watches the panes of four tabs
  for (let index = 0; index < 64; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  expect([w.started.length, w.frames]).toEqual([64, []]);
  // one more pane: nothing is started for it, and its view is told it ended, as any view that cannot start is. No
  // error is sent with it: a page writes an error it does not know into every terminal it shows
  w.watchPane(w.client, "w1:p64", GRID);
  expect(w.started).toHaveLength(64);
  expect(w.frames).toEqual([{ type: "watch-end", pane_id: "w1:p64" }]);
  // and the connection's end stops them all
  w.end(w.client, "closed");
  expect(w.started.filter((process) => process.killed > 0)).toHaveLength(64);
});

it("starts a view asked for at the limit once a pane given up before it has ended its process, and tells it no end meanwhile", async () => {
  const w = watching();
  for (let index = 0; index < 64; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  // a tab left the page's recent ones and another came: its panes are given up and the next tab's asked for in one read
  w.unwatchPane(w.client, "w1:p0");
  w.unwatchPane(w.client, "w1:p1");
  w.watchPane(w.client, "w1:p64", GRID);
  w.watchPane(w.client, "w1:p65", GRID);
  // 64 processes still: the two views wait for the two that were asked to end, and are told nothing
  expect([w.started.length, w.frames]).toEqual([64, []]);
  // a third has no place to wait for
  w.watchPane(w.client, "w1:p66", GRID);
  expect(w.frames).toEqual([{ type: "watch-end", pane_id: "w1:p66" }]);
  // asked for again while it waits: it starts at the grid asked for last
  w.watchPane(w.client, "w1:p65", { cols: 100, rows: 30 });
  await w.started[0]!.exit();
  expect(w.started.slice(64).map((process) => [process.paneId, process.cols])).toEqual([["w1:p64", 80]]);
  await w.started[1]!.exit();
  expect(w.started.slice(64).map((process) => [process.paneId, process.cols])).toEqual([["w1:p64", 80], ["w1:p65", 100]]);
  expect(w.frames).toHaveLength(1);
});

it("counts a view that ended by itself no more: the next view asked for takes its place once its process has exited", async () => {
  const w = watching();
  for (let index = 0; index < 64; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  // a pane closed: herdr says so before its observe process is gone
  w.started[0]!.end();
  w.watchPane(w.client, "w1:p64", GRID);
  expect([w.started.length, w.frames]).toEqual([64, [{ type: "watch-end", pane_id: "w1:p0" }]]);
  await w.started[0]!.exit();
  expect(w.started.slice(64).map((process) => process.paneId)).toEqual(["w1:p64"]);
});

it("keeps the place a waiting view was given: the pane given up for it is not watched again in its stead", async () => {
  const w = watching();
  for (let index = 0; index < 64; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  w.unwatchPane(w.client, "w1:p0");
  w.watchPane(w.client, "w1:p64", GRID);
  // 63 views run and one waits: the pane given up is a 65th
  w.watchPane(w.client, "w1:p0", GRID);
  expect(w.frames).toEqual([{ type: "watch-end", pane_id: "w1:p0" }]);
  await w.started[0]!.exit();
  expect(w.started.slice(64).map((process) => process.paneId)).toEqual(["w1:p64"]);
});

it("forgets a view that waits for a place when it is given up, and when its connection ends", async () => {
  const w = watching();
  for (let index = 0; index < 64; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  w.unwatchPane(w.client, "w1:p0");
  w.watchPane(w.client, "w1:p64", GRID);
  w.unwatchPane(w.client, "w1:p64");
  await w.started[0]!.exit();
  expect(w.started).toHaveLength(64);
  // the place is free now: a view asked for starts at once
  w.watchPane(w.client, "w1:p64", GRID);
  expect(w.started).toHaveLength(65);
  w.unwatchPane(w.client, "w1:p1");
  w.watchPane(w.client, "w1:p65", GRID);
  w.end(w.client, "closed");
  await w.started[1]!.exit();
  expect([w.started.length, w.frames]).toEqual([65, []]);
});

it("holds no more than 64 processes for frames that ask for panes and give them up over and over", async () => {
  const w = watching();
  for (let index = 0; index < 10; index++) w.watchPane(w.client, `w1:p${index}`, GRID);
  // each is given up at once, and its process is still there until the event loop turns
  for (let index = 0; index < 3000; index++) { w.watchPane(w.client, `x${index}`, GRID); w.unwatchPane(w.client, `x${index}`); }
  expect([w.started.length, w.frames]).toEqual([64, []]);
  // as they end, nothing starts in their places: none of those views is wanted any more
  for (const process of w.started.slice(10)) await process.exit();
  expect(w.started).toHaveLength(64);
});

it("runs one observe process for a pane at a time: watched again, it starts once the last has exited, at the grid asked for last", async () => {
  const w = watching();
  w.watchPane(w.client, "w1:p1", GRID);
  // frames naming one pane over and over, in one read: started at each, every process would live until the event
  // loop turned (3,000 frames were 3,000 processes and 9,000 descriptors), past any count of panes
  for (let cols = 81; cols <= 400; cols++) w.watchPane(w.client, "w1:p1", { cols, rows: 24 });
  expect(w.started.map((process) => [process.cols, process.killed])).toEqual([[80, 1]]);
  await w.started[0]!.exit();
  expect(w.started.map((process) => process.cols)).toEqual([80, 400]);
  // the page hears of no end: its view was replaced, as before
  expect(w.frames).toEqual([]);
  // an unwatch while the replacement waits: nothing starts in its place
  w.watchPane(w.client, "w1:p1", { cols: 90, rows: 24 });
  w.unwatchPane(w.client, "w1:p1");
  await w.started[1]!.exit();
  expect(w.started).toHaveLength(2);
  // and the pane can be watched afresh
  w.watchPane(w.client, "w1:p1", GRID);
  expect(w.started).toHaveLength(3);
  // given up and watched again, over and over, before its process has exited: still that one process, asked to end once
  for (let cols = 81; cols <= 400; cols++) { w.unwatchPane(w.client, "w1:p1"); w.watchPane(w.client, "w1:p1", { cols, rows: 24 }); }
  expect([w.started.length, w.started[2]!.killed]).toEqual([3, 1]);
  await w.started[2]!.exit();
  expect(w.started.map((process) => process.cols)).toEqual([80, 400, 80, 400]);
  expect(w.frames).toEqual([]);
});

it("tells the page once of a view that ended by itself, and starts one asked for meanwhile once its process has exited", async () => {
  const w = watching();
  const end = { type: "watch-end", pane_id: "w1:p1" };
  w.watchPane(w.client, "w1:p1", GRID);
  // its pane closed: herdr says so before the process is gone, and the page hears at once, and once
  w.started[0]!.end();
  expect(w.frames).toEqual([end]);
  await w.started[0]!.exit();
  expect(w.frames).toEqual([end]);
  // nothing is left of it: watched again, the pane's view starts at once
  w.watchPane(w.client, "w1:p1", { cols: 100, rows: 30 });
  expect(w.started.map((process) => process.cols)).toEqual([80, 100]);
  // watched again while a view that ended by itself still has its process: that is asked to end, and waited for
  w.started[1]!.end();
  w.watchPane(w.client, "w1:p1", { cols: 90, rows: 28 });
  expect([w.started.length, w.started[1]!.killed, w.frames]).toEqual([2, 1, [end, end]]);
  await w.started[1]!.exit();
  expect(w.started.map((process) => process.cols)).toEqual([80, 100, 90]);
  // a process that exits without a word (it crashed) ends its view too
  await w.started[2]!.exit();
  expect([w.started.length, w.frames]).toEqual([3, [end, end, end]]);
});

it("ends the view of a pane whose next process cannot be started, and leaves the pane free to be watched", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const w = watching();
    w.watchPane(w.client, "w1:p1", GRID);
    w.watchPane(w.client, "w1:p1", { cols: 100, rows: 30 });
    w.next.fails = true;
    await w.started[0]!.exit();
    expect([w.started.length, w.frames]).toEqual([1, [{ type: "watch-end", pane_id: "w1:p1" }]]);
    w.watchPane(w.client, "w1:p1", GRID);
    expect(w.started).toHaveLength(2);
  } finally { warn.mockRestore(); }
});

it("starts nothing for a connection that ended while a view's replacement waited", async () => {
  const w = watching();
  w.watchPane(w.client, "w1:p1", GRID);
  w.watchPane(w.client, "w1:p1", { cols: 100, rows: 30 });
  w.end(w.client, "closed");
  await w.started[0]!.exit();
  expect(w.started).toHaveLength(1);
});

it("a stall ends the connection once and leaves its presence to the socket's close", () => {
  const { client, clients, present, log, end } = harness();
  end(client, "stalled");
  end(client, "stalled");
  expect(log).toEqual(["pending closed", "detach claimed", "drop claims", `closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output consumer stalled`]);
  expect(clients.has(client)).toBe(false);
  expect(present.has(client)).toBe(true);
  expect(send(client, { type: "session-changed" })).toBe(0);
  end(client, "closed");
  expect(present.has(client)).toBe(false);
});

it("sends one frame larger than the transport budget and keeps the client while it drains, but not a backlog past the budget (#2566)", () => {
  const { client, log } = harness();
  // the socket queues what it is given and drains from the front only when the test says so
  let buffered = 0;
  const sent: number[] = [];
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { sent.push(raw.length); buffered += Buffer.byteLength(raw); return -1; } });
  const frame = (bytes: number) => ({ type: "error", code: "x", message: "x".repeat(bytes) }) as const;
  const big = frame(OUTPUT_HARD_BYTES);
  const bigBytes = Buffer.byteLength(JSON.stringify(big));
  const half = frame(600 * 1024);
  const halfBytes = Buffer.byteLength(JSON.stringify(half));
  expect(send(client, big)).toBe(-1);
  expect(backlog(client)).toBe(0);
  // what follows the large frame is still sent while it drains, and counts in full
  expect(send(client, half)).toBe(-1);
  expect(backlog(client)).toBe(halfBytes);
  // all but the large frame's last 10 bytes drained: what queued behind it is still a backlog
  buffered -= bigBytes - 10;
  expect(backlog(client)).toBe(halfBytes);
  expect(send(client, half)).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
  expect(sent).toHaveLength(2);
});

it("excuses a second large frame sent while the first still drains, and counts what follows both (#2573)", () => {
  const { client, log } = harness();
  let buffered = 0;
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { buffered += Buffer.byteLength(raw); return -1; } });
  const big = { type: "error", code: "x", message: "x".repeat(OUTPUT_HARD_BYTES) } as const;
  const bigBytes = Buffer.byteLength(JSON.stringify(big));
  const small = { type: "error", code: "x", message: "x".repeat(1000) } as const;
  const smallBytes = Buffer.byteLength(JSON.stringify(small));
  expect(send(client, big)).toBe(-1);
  expect(send(client, small)).toBe(-1);
  // a mirrored screen whose JSON escaping takes it past the budget, while the snapshot is queued
  expect(send(client, big)).toBe(-1);
  expect(backlog(client)).toBe(smallBytes);
  expect(send(client, small)).toBe(-1);
  expect(backlog(client)).toBe(2 * smallBytes);
  // the first drained, and part of the second
  buffered -= bigBytes + smallBytes + 100;
  expect(backlog(client)).toBe(smallBytes);
  expect(log).toEqual([]);
});

it("holds the large frames queued at once to herdr's largest reply", () => {
  const { client, log } = harness();
  let buffered = 0;
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { buffered += Buffer.byteLength(raw); return -1; } });
  const big = { type: "error", code: "x", message: "x".repeat(LARGE_REPLY_BYTES / 2) } as const;
  expect(send(client, big)).toBe(-1);
  expect(send(client, big)).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
});

it("closes a client whose large frame stops draining, once the slowest link would have taken it, and keeps one that drained (#2573)", () => {
  jest.useFakeTimers();
  try {
    for (const drains of [false, true]) {
      const { client, log } = harness();
      let buffered = 0;
      Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { buffered += Buffer.byteLength(raw); return -1; } });
      const big = { type: "error", code: "x", message: "x".repeat(OUTPUT_HARD_BYTES) } as const;
      expect(send(client, big)).toBe(-1);
      const allowed = OUTPUT_STALL_MS + Math.ceil(buffered * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
      jest.advanceTimersByTime(allowed - 1);
      expect(log).toEqual([]);
      if (drains) buffered = 0;
      jest.advanceTimersByTime(1);
      expect(log).toEqual(drains ? [] : [`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
    }
  } finally {
    jest.useRealTimers();
  }
});

it("closes a client whose backlog of ordinary frames would pass the transport budget", () => {
  const { client, log } = harness();
  Object.assign(client, { getBufferedAmount: () => OUTPUT_HARD_BYTES - 10 });
  expect(send(client, { type: "error", code: "x", message: "x".repeat(20) })).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
});

it("ends the machine-event subscription, never the terminal connection, rather than put more than OUTPUT_LOW_BYTES of machine events on the socket", () => {
  const listeners = new Set<(preferences: SharedPreferences) => void>();
  const preferences = (bytes: number) => ({ revision: 1, settings: { note: "x".repeat(bytes) } }) as unknown as SharedPreferences;
  let initial = 200;
  const machineEvents: MachineEventDocument = {
    manager: { subscribe: () => () => {} },
    preferences: { get: () => preferences(initial), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  };
  const subscribe = (queued: number) => {
    const { client, log } = harness({ machineEvents });
    let buffered = queued;
    const sent: string[] = [];
    Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { sent.push((JSON.parse(raw) as ServerMessage).type); buffered += Buffer.byteLength(raw); return -1; } });
    setMachineEvents(client, true);
    return { client, log, sent, queue: (bytes: number) => { buffered = bytes; } };
  };
  // a backlog with no room left even for the ending notice: still told, and the terminal kept
  for (const queued of [OUTPUT_HARD_BYTES - 10, OUTPUT_LOW_BYTES - 100]) {
    const { log, sent } = subscribe(queued);
    expect(log).toEqual([]);
    expect(sent).toEqual(["machine-events-ended"]);
    expect(listeners.size).toBe(0);
  }
  // a small document on an empty queue goes out; a live event that would pass the cap ends it
  const small = subscribe(0);
  expect(small.sent).toEqual(["machine-event"]);
  expect(listeners.size).toBe(1);
  small.queue(OUTPUT_LOW_BYTES - 100);
  for (const listener of [...listeners]) listener(preferences(200));
  expect(small.log).toEqual([]);
  expect(small.sent).toEqual(["machine-event", "machine-events-ended"]);
  expect(listeners.size).toBe(0);
  // a roster of 768 KiB-1 MiB on an empty queue never rides the socket: the page moves to SSE, and
  // the 256 KiB of terminal output that follows is sent with nothing of it in front
  initial = 900 * 1024;
  const large = subscribe(0);
  expect(large.sent).toEqual(["machine-events-ended"]);
  expect(listeners.size).toBe(0);
  const output = "x".repeat(256 * 1024);
  expect(send(large.client, { type: "pty-data", pane_id: "w1:p1", data: output } as unknown as ServerMessage)).toBe(-1);
  expect(backlog(large.client)).toBeLessThan(OUTPUT_HIGH_BYTES + 1024);
  expect(large.log).toEqual([]);
  expect(large.sent).toEqual(["machine-events-ended", "pty-data"]);
});

it("ends the machine-event subscription, never the terminal connection, when the socket refuses a machine event", () => {
  const machineEvents: MachineEventDocument = {
    manager: { subscribe: () => () => {} },
    preferences: { get: () => ({ revision: 1, settings: {} }) as unknown as SharedPreferences, subscribe: () => () => {} },
  };
  const { client, log } = harness({ machineEvents });
  const sent: string[] = [];
  Object.assign(client, { send: (raw: string) => { const type = (JSON.parse(raw) as ServerMessage).type; sent.push(type); return type === "machine-event" ? 0 : 1; } });
  setMachineEvents(client, true);
  expect(log).toEqual([]);
  expect(sent).toEqual(["machine-event", "machine-events-ended"]);
});

it("a revoke ends the connection with 1008 and leaves its pending input to the socket's close", () => {
  const { client, clients, present, log, admit, revoke, end, mayType, authorizeSocket } = harness({ deviceId: "phone" });
  expect(admit(client)).toBe(true);
  expect(mayType(client)).toBe(true);
  revoke();
  expect(log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
  expect(clients.has(client) || present.has(client)).toBe(false);
  expect(mayType(client)).toBe(false);
  expect(() => authorizeSocket(client)).toThrow("this device's access was revoked");
  end(client, "closed");
  expect(log.slice(3)).toEqual(["unwatch device", "pending closed", "detach claimed", "drop claims"]);
});

it("does not admit a device that was revoked before its socket opened", () => {
  const { client, log, admit } = harness({ deviceId: "phone", revokedAlready: true });
  expect(admit(client)).toBe(false);
  expect(log.at(-1)).toBe("closed 1008 Device access revoked");
});

it("revoking every device ends local and relayed device connections alike, and admits none after", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-connections-revoke-all-"));
  try {
    const store = new DeviceStore(root);
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    store.match(phone.token);
    const tablet = store.pair(store.startPairing().code, "Tablet", "drive")!;
    store.match(tablet.token);
    const relayed: string[] = [];
    const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
    const local = harness({ deviceId: phone.device.id, store });
    const remote = harness({ deviceId: tablet.device.id, relay, store });
    expect(local.admit(local.client)).toBe(true);
    expect(remote.admit(remote.client)).toBe(true);
    expect(store.revokeAll().sort()).toEqual([phone.device.id, tablet.device.id].sort());
    expect(local.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    expect(remote.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    // the relayed connection's relay is closed with the revocation itself, before its socket's own close
    expect(relayed).toEqual(["relay closed"]);
    expect(local.mayType(local.client)).toBe(false);
    expect(() => remote.authorizeSocket(remote.client)).toThrow("this device's access was revoked");
    remote.end(remote.client, "closed");
    expect(relayed).toEqual(["relay closed", "relay closed"]);
    // a socket that opens with a revoked device's cookie after the fact is closed at once
    const late = harness({ deviceId: phone.device.id, store });
    expect(late.admit(late.client)).toBe(false);
    expect(late.log.at(-1)).toBe("closed 1008 Device access revoked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("ends a connection the open LAN let in once the gate closes, and admits none after", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-connections-gate-"));
  try {
    const store = new DeviceStore(root);
    const relayed: string[] = [];
    const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
    // another machine on the LAN while nothing is paired, and its connection to a remote PC through this one
    const stranger = harness({ open: true, store });
    const proxied = harness({ open: true, relay, store });
    // let in another way (this PC itself, a token, a Tailscale login): not the gate's to end
    const local = harness({ store });
    // one that closed by itself before the gate did
    const gone = harness({ open: true, store });
    for (const each of [stranger, proxied, local, gone]) expect(each.admit(each.client)).toBe(true);
    gone.end(gone.client, "closed");
    gone.log.length = 0;
    expect(stranger.mayType(stranger.client)).toBe(true);
    // the first device: its cookie is taken only once it came back, and that write closes the gate
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    expect([store.gated, stranger.log]).toEqual([false, []]);
    store.match(phone.token);
    // told right after the call that closed the gate, with the store saying so
    expect([store.gated, stranger.log]).toEqual([true, []]);
    await Promise.resolve();
    expect(stranger.log).toEqual(["detach claimed", "drop claims", "closed 1008 Pairing required"]);
    expect(proxied.log).toEqual(["detach claimed", "drop claims", "closed 1008 Pairing required"]);
    expect(relayed).toEqual(["relay closed"]);
    expect([stranger.clients.has(stranger.client), stranger.present.has(stranger.client), stranger.mayType(stranger.client)]).toEqual([false, false, false]);
    expect(() => stranger.authorizeSocket(stranger.client)).toThrow("pair this device");
    expect([local.log, local.mayType(local.client), gone.log]).toEqual([[], true, []]);
    // told once: a second device, and revoking them all, find no open connection left to end
    const tablet = store.pair(store.startPairing().code, "Tablet", "drive")!;
    store.match(tablet.token);
    store.revokeAll();
    await Promise.resolve();
    expect(stranger.log).toHaveLength(3);
    // an upgrade the open LAN passed just before the gate closed is not admitted
    const late = harness({ open: true, store });
    expect(late.admit(late.client)).toBe(false);
    expect(late.log.at(-1)).toBe("closed 1008 Pairing required");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("ends an open connection when the relay is turned on, which closes the gate with no device paired", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-connections-gate-relay-"));
  try {
    const store = new DeviceStore(root);
    const stranger = harness({ open: true, store });
    expect(stranger.admit(stranger.client)).toBe(true);
    store.closeGate();
    await Promise.resolve();
    expect(stranger.log).toEqual(["detach claimed", "drop claims", "closed 1008 Pairing required"]);
    store.closeGate();
    await Promise.resolve();
    expect(stranger.log).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("closes only the relay of a relayed connection", () => {
  const relayed: string[] = [];
  const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
  const { client, present, log, end } = harness({ relay });
  end(client, "closed");
  expect(relayed).toEqual(["relay closed"]);
  expect(log).toEqual([]);
  expect(present.has(client)).toBe(false);
});

it("counts each change of role, and a read-only connection only watches", () => {
  const { client, setRole, mayType } = harness();
  setRole(client, "interact");
  expect(connectionOf(client).roles).toBe(0);
  setRole(client, "observe");
  setRole(client, "interact");
  expect(connectionOf(client)).toMatchObject({ mode: "interact", roles: 2 });
  expect(mayType(client)).toBe(true);
  const watcher = harness({ readOnly: true });
  expect(connectionOf(watcher.client).mode).toBe("observe");
  expect(() => watcher.authorizeSocket(watcher.client)).toThrow("this connection can only watch");
});
