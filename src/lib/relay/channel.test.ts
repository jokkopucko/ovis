import { afterEach, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceStore } from "../../../server/devices.ts";
import { bounded } from "../../../server/relay/test-helpers.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../../../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { MuxFrame } from "../../../shared/relay-mux.ts";
import { MuxEngine } from "../../../shared/relay-mux-engine.ts";
import { ADMISSION_MS, ASSIGNMENT_MS, openRelayChannel, PC_ANSWER_MS, RelayAdmissionTimeoutError, RelayPcOfflineError, RelayUnreachableError } from "./channel.ts";
import type { RelaySocket } from "./channel.ts";
import { failureOf } from "./shellState.ts";
import { base64url, getDevice } from "./device.ts";
import { MemoryDeviceStore } from "./device.test.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); jest.useRealTimers(); });

class FakeSocket implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed = false;
  /** closing with no close event yet, as a browser socket the page closed while the relay has not answered */
  closing = false;
  get readyState(): number { return this.closed ? 3 : this.closing ? 2 : 1; }
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    // a browser socket in CLOSING drops what it is given, without an error
    if (this.closing) return;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
  }
  deliver(data: string | ArrayBuffer): void {
    if (!this.closed) this.onmessage?.(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.daemon.onclose?.(code, reason);
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

async function fixture(pairing: boolean, attack?: "welcome" | "nonce" | "ping" | "auth-ok" | "features" | "assigned" | "receipt" | "silence" | "protocol", onClose?: (error: Error) => void) {
  const dir = mkdtempSync(join(tmpdir(), "relay-channel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new DeviceStore(dir);
  const keys = generateKeyPair();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example",
    ...(pairing ? { code: registry.startPairing().code } : {}) };
  const store = new MemoryDeviceStore();
  if (!pairing) {
    const device = await getDevice(offer, store);
    const paired = registry.pairRelay(registry.startPairing().code, device.label, device.public_spki);
    if (!paired) throw new Error("Fixture pairing failed");
    await store.update(offer.server_id, (current) => ({ ...(current ?? device), device_id: paired.device.id }));
  }
  const nonce = new Uint8Array(32).fill(9);
  const trace: string[] = [];
  const authSeen = Promise.withResolvers<void>();
  const allowAuth = Promise.withResolvers<void>();
  const httpSeen = Promise.withResolvers<string>();
  let secure: SecureChannel;
  let server: MuxEngine;
  let socket: FakeSocket;
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => socket.deliver(data),
    close: (code, reason) => socket.close(code, reason),
  };
  socket = new FakeSocket(daemon);
  cleanups.push(() => { server?.carrierLost(); socket.close(); });
  const fail = (error: unknown): void => {
    authSeen.reject(error);
    httpSeen.reject(error);
    socket.close(4000);
  };
  // These signals are also present in malformed-input cases that never reach admission.
  void authSeen.promise.catch(() => {});
  void httpSeen.promise.catch(() => {});
  let incoming = Promise.resolve();
  const daemonOpening = openDaemonSecureChannel(daemon, {
    daemonKeyPair: keys,
    events: { onmessage: (data) => {
      if (!(data instanceof ArrayBuffer)) throw new Error("Expected mux bytes");
      const bytes = new Uint8Array(data);
      const frame = decodeFrame(bytes);
      trace.push(`client:${Object.entries(FrameType).find(([, value]) => value === frame.type)?.[0]}`);
      incoming = incoming.then(async () => { await daemonOpening; server.receive(bytes); }).catch(fail);
    } },
  }).then((channel) => {
    secure = channel;
    server = new MuxEngine({
      role: "server", send: (bytes) => channel.send(bytes.slice().buffer),
      close: () => socket.close(4000),
      clock: { now: () => 0, setTimeout: () => () => {} },
      outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: 0, maxWireMessageBytes: 65536,
      onHttp: (stream) => { httpSeen.resolve(stream.request.target); stream.headers(200); stream.end(); },
      onSession: (frame) => { void handle(frame).catch(fail); },
    });
  });
  void daemonOpening.catch(() => {});
  const raw = (type: number, payload: unknown): Uint8Array => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(8 + body.length);
    bytes[0] = 1; bytes[1] = type; bytes.set(body, 8);
    return bytes;
  };
  const handle = async (frame: MuxFrame): Promise<void> => {
    if (frame.type === FrameType.HELLO) {
      // a PC that finished the handshake and then hung: nothing answers HELLO
      if (attack === "silence") return;
      if (attack === "receipt") {
        await secure.send(encodeFrame({ type: FrameType.RECEIVED, flags: 0, stream_id: 0, payload: 99n }).slice().buffer);
        return;
      }
      if (attack === "ping") {
        await secure.send(encodeFrame({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 1n }).slice().buffer);
        return;
      }
      if (attack === "auth-ok") {
        await secure.send(encodeFrame({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
          payload: { device_id: "ab".repeat(8), session_id: "cd".repeat(16), role: "drive" } }).slice().buffer);
        return;
      }
      const welcome = { protocol: "ovis-mux" as const, version: 1 as const, features: attack === "features" ? ["unoffered"] : [],
        limits: { ...LIMITS_V1, max_streams: 2 }, nonce: attack === "nonce" ? base64url(nonce.slice(1)) : base64url(nonce),
        server_version: "test", relay_protocol: attack === "protocol" ? 2 : 1, min_supported_client: "0.0.0" };
      trace.push("server:WELCOME");
      if (attack === "welcome" || attack === "nonce") {
        await secure.send(raw(FrameType.WELCOME, attack === "welcome" ? { ...welcome, protocol: "wrong" } : welcome).slice().buffer);
      } else {
        server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: welcome });
      }
      return;
    }
    let deviceId: string;
    if (frame.type === FrameType.PAIR) {
      const paired = registry.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key);
      if (!paired) throw new Error("Pairing rejected");
      deviceId = paired.device.id;
    } else if (frame.type === FrameType.AUTH) {
      const matched = await registry.matchRelay(frame.payload.device_id, nonce, frame.payload.signature, offer.server_id);
      if (!matched) throw new Error("Authentication rejected");
      deviceId = matched.id;
    } else throw new Error("Unexpected client setup frame");
    authSeen.resolve();
    await allowAuth.promise;
    trace.push("server:AUTH_OK");
    server.sendSession({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
      payload: { session_id: "cd".repeat(16), device_id: deviceId, role: "drive" } });
    await server.flush();
    server.authenticate(deviceId);
  };
  const opening = openRelayChannel(offer, { store, ...(onClose ? { onClose } : {}), socket: (url) => {
    expect(url).toBe(`${offer.relay}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
    queueMicrotask(() => socket.deliver(JSON.stringify(attack === "assigned" ? { type: "wrong" } : { type: "assigned", connection_id: "ef".repeat(16) })));
    return socket;
  } });
  return { opening, trace, authSeen, allowAuth, httpSeen, socket, store, offer };
}

for (const pairing of [false, true]) {
  it(`sends only HELLO and ${pairing ? "PAIR" : "AUTH"} until AUTH_OK through real Noise and mux`, async () => {
    // Given a real daemon, a real server mux and a relay-shaped in-memory socket.
    const f = await fixture(pairing);
    // When admission is deliberately held at its exact signal.
    await f.authSeen.promise;
    expect(f.trace).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`]);
    f.allowAuth.resolve();
    const channel = await f.opening;
    // Then admission persists the id and enables actual application streams.
    expect(channel.device.device_id).toBe((await f.store.get(f.offer.server_id))?.device_id ?? null);
    expect(channel.connectionId).toBe("ef".repeat(16));
    expect(channel.mux.limits.max_streams).toBe(2);
    expect(channel.server).toEqual({ version: "test", relayProtocol: 1 });
    expect(f.trace.slice(0, 4)).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`, "server:AUTH_OK"]);
    console.log(`ORDER: ${f.trace.slice(0, 4).join(" -> ")}; no other client frame before AUTH_OK`);
    channel.mux.openHttp({ method: "GET", target: "/api/test", headers: [], body: "none" });
    expect(await f.httpSeen.promise).toBe("/api/test");
    channel.close();
  });
}

it("ends an admitted channel whose socket is closing, rather than sending into it", async () => {
  // Given an admitted channel.
  const lost = Promise.withResolvers<Error>();
  const f = await fixture(false, undefined, (error) => lost.resolve(error));
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect(channel.carrierOpen).toBe(true);
  // When its socket starts closing and no close event comes (the page closed it, the relay has not answered).
  f.socket.closing = true;
  // Then the channel reads its carrier as gone, and the next frame ends the channel instead of vanishing.
  expect(channel.carrierOpen).toBe(false);
  channel.mux.openHttp({ method: "GET", target: "/api/lost", headers: [], body: "none" });
  expect(await bounded(lost.promise, 2000)).toBeInstanceOf(MuxProtocolError);
  expect(f.socket.closed).toBe(true);
});

/**
 * A relay-shaped socket that delivers nothing on its own: the test says what arrives and when.
 * `sent` resolves at the client's first frame, the start of its handshake.
 */
class SilentSocket implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed: number | null = null;
  readonly sent = Promise.withResolvers<void>();
  get readyState(): number { return this.closed === null ? 1 : 3; }
  send(): void { this.sent.resolve(); }
  deliver(data: string | ArrayBuffer): void { if (this.closed === null) this.onmessage?.(new MessageEvent("message", { data })); }
  close(code = 1000): void { if (this.closed === null) this.closed = code; }
}

/** The fixture's rejection as a settled value, so a fake clock can be advanced while it is pending. */
function settled(promise: Promise<unknown>): { get(): { error: unknown } | null } {
  let result: { error: unknown } | null = null;
  promise.then(() => { result = { error: null }; }, (error: unknown) => { result = { error }; });
  return { get: () => result };
}

/** Enough microtask turns for an async function's adopted rejection to reach its handlers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

it("calls a relay that never assigns the connection unreachable, after ASSIGNMENT_MS", async () => {
  // Given a socket the relay accepted but never spoke on.
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  // When the assignment deadline passes with nothing from the relay.
  jest.advanceTimersByTime(ASSIGNMENT_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  // Then the failure names the relay, not the PC, and the socket is closed.
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayUnreachableError);
  expect(error).toMatchObject({ closeCode: null, silent: true });
  expect(failureOf(error, { code: true, paired: false })).toBe("relay-unreachable");
  expect(socket.closed).toBe(4000);
});

it("calls the PC offline when the relay assigned the connection but nothing answered within PC_ANSWER_MS", async () => {
  // Given a relay that assigns the connection and a PC that never attaches.
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  // the client's handshake went out: the relay has answered, the PC's deadline is running
  await socket.sent.promise;
  // When the relay's old deadline would have passed, then the PC's.
  jest.advanceTimersByTime(ASSIGNMENT_MS);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(PC_ANSWER_MS - ASSIGNMENT_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  // Then the failure is the PC's silence, the screen is pc-offline, and the socket is closed.
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayPcOfflineError);
  expect(error).toBeInstanceOf(MuxProtocolError);
  expect(error).toMatchObject({ code: "timeout" });
  expect(failureOf(error, { code: false, paired: true })).toBe("pc-offline");
  expect(socket.closed).toBe(4000);
});

it("waits for the PC as long as pcAnswerMs says, for a reconnect behind the app", async () => {
  // Given a relay that assigns the connection, a PC that never attaches, and a longer wait asked for.
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), pcAnswerMs: 25_000, socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  await socket.sent.promise;
  // When PC_ANSWER_MS passes, then the asked-for wait.
  jest.advanceTimersByTime(PC_ANSWER_MS);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(25_000 - PC_ANSWER_MS);
  await flush();
  // Then the PC is called offline only at the end of that wait.
  expect(outcome.get()?.error).toBeInstanceOf(RelayPcOfflineError);
});

it("calls a PC that answered the handshake but never finished admission unresponsive, not offline", async () => {
  // Given a real daemon that completes Noise and then never answers HELLO.
  jest.useFakeTimers();
  const f = await fixture(false, "silence");
  const outcome = settled(f.opening);
  // the PC's first frame reached the client (the trace sees the client's HELLO go out only after it did)
  for (let i = 0; i < 200 && !f.trace.includes("client:HELLO"); i++) await Promise.resolve();
  expect(f.trace).toEqual(["client:HELLO"]);
  // When the admission deadline passes.
  jest.advanceTimersByTime(ADMISSION_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  // Then it is the PC's admission that stalled, in the welcome phase, and no credential was sent.
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayAdmissionTimeoutError);
  expect(error).toMatchObject({ phase: "welcome" });
  expect(failureOf(error, { code: false, paired: true })).toBe("pc-unresponsive");
  expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(["client:HELLO"]);
  expect(f.socket.closed).toBe(true);
});

it("keeps no key from a pairing link whose PC never admitted the phone", async () => {
  // Given a pairing offer whose PC completes Noise and then never admits anyone.
  jest.useFakeTimers();
  const f = await fixture(true, "silence");
  const outcome = settled(f.opening);
  for (let i = 0; i < 200 && !f.trace.includes("client:HELLO"); i++) await Promise.resolve();
  // When the admission deadline passes.
  jest.advanceTimersByTime(ADMISSION_MS);
  await flush();
  // Then the attempt failed and this PC's slot is still empty: a later real QR pairs without a warning.
  expect(outcome.get()?.error).toBeInstanceOf(RelayAdmissionTimeoutError);
  expect(await f.store.list()).toEqual([]);
});

it("names a stall after WELCOME in the auth phase, within the same admission budget", async () => {
  // Given a real daemon that welcomes and then holds AUTH_OK.
  jest.useFakeTimers();
  const f = await fixture(false);
  const outcome = settled(f.opening);
  await f.authSeen.promise;
  expect(f.trace).toEqual(["client:HELLO", "server:WELCOME", "client:AUTH"]);
  // When the admission budget, counted from the PC's first frame, runs out without AUTH_OK.
  jest.advanceTimersByTime(ADMISSION_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  // Then the stall is the PC's admission in the auth phase, never an offline PC, and the attempt is over.
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayAdmissionTimeoutError);
  expect(error).toMatchObject({ phase: "auth" });
  expect(failureOf(error, { code: false, paired: true })).toBe("pc-unresponsive");
  expect(f.socket.closed).toBe(true);
});

it("stops at a PC of another relay protocol before any credential, as an update", async () => {
  // Given a real daemon whose WELCOME names relay protocol 2.
  const f = await fixture(false, "protocol");
  // When the client reads it.
  const error = await f.opening.catch((caught: unknown) => caught);
  // Then the attempt ends on the update screen and no AUTH was sent.
  expect(error).toMatchObject({ code: "unsupported_version" });
  expect(failureOf(error, { code: false, paired: true })).toBe("needs-update");
  expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(["client:HELLO"]);
  expect(f.socket.closed).toBe(true);
});

for (const attack of ["welcome", "nonce", "ping", "auth-ok", "features", "assigned", "receipt"] as const) {
  it(`refuses malformed or unexpected ${attack} without sending credentials`, async () => {
    // Given an encrypted server that sends invalid setup traffic.
    const f = await fixture(false, attack);
    // When its invalid frame reaches the client.
    // Then setup rejects, closes, and sends neither AUTH nor automatic mux controls.
    await expect(f.opening).rejects.toBeInstanceOf(MuxProtocolError);
    expect(f.socket.closed).toBe(true);
    expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(attack === "assigned" ? [] : ["client:HELLO"]);
  });
}
