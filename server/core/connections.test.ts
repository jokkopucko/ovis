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

function harness({ deviceId, readOnly = false, relay, revokedAlready = false, store, machineEvents }: { deviceId?: string; readOnly?: boolean; relay?: MachineRelay; revokedAlready?: boolean; store?: DeviceStore; machineEvents?: MachineEventDocument } = {}) {
  const log: string[] = [];
  const revocations: (() => void)[] = [];
  const devices = store ?? {
    onRevoke: (_id: string, close: () => void) => {
      if (revokedAlready) close(); else revocations.push(close);
      return () => log.push("unwatch device");
    },
  } as unknown as DeviceStore;
  const pending = { close: () => log.push("pending closed") } as unknown as PendingInputs<Client, never>;
  const client = {
    data: connectionData({ deviceId, readOnly, ...(relay ? { relay } : {}), ...(machineEvents ? { machineEvents } : {}) }),
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
