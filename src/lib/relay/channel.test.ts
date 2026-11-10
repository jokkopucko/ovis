import { afterEach, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceStore } from "../../../server/devices.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded, relayFixture } from "../../../server/relay/test-helpers.ts";
import type { RelayPairingRequest } from "../../../shared/machines.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../../../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { MuxFrame } from "../../../shared/relay-mux.ts";
import { MuxEngine } from "../../../shared/relay-mux-engine.ts";
import { ADMISSION_MS, ASSIGNMENT_MS, openRelayChannel, PC_ANSWER_MS, RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayPcOfflineError, RelayUnreachableError } from "./channel.ts";
import { isFatalRelayError } from "./transport.ts";
import { RELAY_NEW_SESSIONS_CLOSE, RELAY_NEW_SESSIONS_REFUSED } from "../../../shared/relay-pass.ts";
import type { RelaySocket } from "./channel.ts";
import { failureOf, pairsAgainWithoutKey } from "./shellState.ts";
import { base64url, getDevice } from "./device.ts";
import { MemoryDeviceStore } from "./device.test.ts";
import { GLOBAL_RELAY } from "../../../shared/relay-regions.ts";

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

async function fixture(pairing: boolean, attack?: "welcome" | "nonce" | "ping" | "auth-ok" | "features" | "assigned" | "receipt" | "silence" | "protocol" | "early-welcome" | "account", onClose?: (error: Error) => void,
  pc: { relay?: string; hints?: readonly string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-channel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new DeviceStore(dir);
  const keys = generateKeyPair();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: pc.relay ?? "wss://relay.example",
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
  let offered: readonly string[] = [];
  let hinting = false;
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
    // a PC that sends WELCOME right behind its handshake answer, before the phone's HELLO arrives
    if (attack === "early-welcome") {
      trace.push("server:WELCOME");
      server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: welcome() });
    }
  });
  void daemonOpening.catch(() => {});
  const welcome = () => ({ protocol: "ovis-mux" as const, version: 1 as const, features: attack === "features" ? ["unoffered"] : attack === "account" ? ["account"] : [],
    limits: { ...LIMITS_V1, max_streams: 2 }, nonce: attack === "nonce" ? base64url(nonce.slice(1)) : base64url(nonce),
    server_version: "test", relay_protocol: attack === "protocol" ? 2 : 1, min_supported_client: "0.0.0" });
  const raw = (type: number, payload: unknown): Uint8Array => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(8 + body.length);
    bytes[0] = 1; bytes[1] = type; bytes.set(body, 8);
    return bytes;
  };
  const handle = async (frame: MuxFrame): Promise<void> => {
    if (frame.type === FrameType.HELLO) {
      offered = frame.payload.features;
      hinting = pc.hints !== undefined && offered.includes("relay-hints");
      // a PC that finished the handshake and then hung: nothing answers HELLO
      if (attack === "silence" || attack === "early-welcome") return;
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
      trace.push("server:WELCOME");
      if (attack === "welcome" || attack === "nonce") {
        await secure.send(raw(FrameType.WELCOME, attack === "welcome" ? { ...welcome(), protocol: "wrong" } : welcome()).slice().buffer);
      } else {
        server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: welcome() });
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
      payload: { session_id: "cd".repeat(16), device_id: deviceId, role: "drive", ...(hinting ? { relays: pc.hints } : {}) } });
    await server.flush();
    server.authenticate(deviceId);
  };
  const opening = openRelayChannel(offer, { store, ...(onClose ? { onClose } : {}), socket: (url) => {
    expect(url).toBe(`${offer.relay}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
    queueMicrotask(() => socket.deliver(JSON.stringify(attack === "assigned" ? { type: "wrong" } : { type: "assigned", connection_id: "ef".repeat(16) })));
    return socket;
  } });
  return { opening, trace, authSeen, allowAuth, httpSeen, socket, store, offer, get offered() { return offered; } };
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
    expect(channel.server).toEqual({ version: "test", relayProtocol: 1, features: [] });
    expect(f.trace.slice(0, 4)).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`, "server:AUTH_OK"]);
    console.log(`ORDER: ${f.trace.slice(0, 4).join(" -> ")}; no other client frame before AUTH_OK`);
    channel.mux.openHttp({ method: "GET", target: "/api/test", headers: [], body: "none" });
    expect(await f.httpSeen.promise).toBe("/api/test");
    channel.close();
  });

  it(`signs in with ${pairing ? "PAIR" : "AUTH"} on a WELCOME the PC sent without waiting for HELLO`, async () => {
    const f = await fixture(pairing, "early-welcome");
    await f.authSeen.promise;
    // this PC never answers HELLO: its one WELCOME went out as soon as its channel opened
    expect(f.trace.filter((entry) => entry === "server:WELCOME")).toHaveLength(1);
    expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(["client:HELLO", `client:${pairing ? "PAIR" : "AUTH"}`]);
    f.allowAuth.resolve();
    const channel = await f.opening;
    expect(channel.server).toEqual({ version: "test", relayProtocol: 1, features: [] });
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

it("names the relay's refusal of a new device (4403), on a code and on compared digits alike, and tries no further", async () => {
  // Given a pairing whose handshake is under way.
  const run = async (code: number) => {
    const socket = new SilentSocket();
    const created = Promise.withResolvers<void>();
    const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example", code: "ABCD-EFGH" };
    const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
    await created.promise;
    socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
    await socket.sent.promise;
    // When the relay closes the socket.
    socket.onclose?.(new CloseEvent("close", { code, reason: code === RELAY_NEW_SESSIONS_CLOSE ? RELAY_NEW_SESSIONS_REFUSED : "" }));
    await flush();
    return outcome.get()?.error;
  };
  // Then 4403 is its own failure and screen, whatever the attempt was, and nothing retries it by itself.
  const refused = await run(RELAY_NEW_SESSIONS_CLOSE);
  expect(refused).toBeInstanceOf(RelayNewSessionsRefusedError);
  expect(failureOf(refused, { code: true, paired: false })).toBe("new-devices-refused");
  expect(failureOf(refused, { code: false, paired: false, codeless: true, compared: true })).toBe("new-devices-refused");
  expect(isFatalRelayError(refused)).toBe(true);
  // A device this PC already knows only signs in, and the relay never refuses that: the same code to it is a lost
  // socket (another host at a saved address, a relay fault), so it reconnects as it always did.
  const store = new MemoryDeviceStore();
  const known = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const paired = await getDevice(known, store);
  await store.update(known.server_id, () => ({ ...paired, device_id: "ab".repeat(8) }));
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const signIn = settled(openRelayChannel(known, { store, socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  await socket.sent.promise;
  socket.onclose?.(new CloseEvent("close", { code: RELAY_NEW_SESSIONS_CLOSE, reason: RELAY_NEW_SESSIONS_REFUSED }));
  await flush();
  expect(signIn.get()?.error).not.toBeInstanceOf(RelayNewSessionsRefusedError);
  expect(isFatalRelayError(signIn.get()?.error)).toBe(false);
  // Any other close there stays a lost connection.
  const lost = await run(1001);
  expect(lost).toBeInstanceOf(MuxProtocolError);
  expect(failureOf(lost, { code: true, paired: false })).toBe("pc-offline");
  expect(isFatalRelayError(lost)).toBe(false);
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

it("offers the account feature in HELLO and keeps what the PC selected, so an older PC can be told apart", async () => {
  const f = await fixture(false, "account");
  await f.authSeen.promise;
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect(channel.server.features).toEqual(["account"]);
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

const REGIONAL = "wss://relay-ap.ovis.sh";

for (const pairing of [false, true]) {
  it(`offers relay hints and saves the regional relay the PC names${pairing ? " when pairing" : ""}`, async () => {
    const f = await fixture(pairing, undefined, undefined, { relay: GLOBAL_RELAY, hints: [REGIONAL, GLOBAL_RELAY] });
    f.allowAuth.resolve();
    const channel = await f.opening;
    expect(f.offered).toContain("relay-hints");
    expect((await f.store.get(f.offer.server_id))?.relay).toBe(REGIONAL);
    expect(channel.device.relay).toBe(REGIONAL);
    channel.close();
  });
}

it("keeps a self-hosted relay whatever relays the PC names", async () => {
  const f = await fixture(false, undefined, undefined, { relay: "wss://relay.example", hints: [REGIONAL, GLOBAL_RELAY] });
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect((await f.store.get(f.offer.server_id))?.relay).toBe("wss://relay.example");
  channel.close();
});

it("keeps Ovis's relay when the PC names one that is not Ovis's", async () => {
  const f = await fixture(false, undefined, undefined, { relay: GLOBAL_RELAY, hints: ["wss://relay.attacker.example", GLOBAL_RELAY] });
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect((await f.store.get(f.offer.server_id))?.relay).toBe(GLOBAL_RELAY);
  channel.close();
});

/** One relay connection from the phone's real channel to the PC's real session, passing frames on. */
function connectReal(f: ReturnType<typeof relayFixture>, keys: ReturnType<typeof generateKeyPair>, offer: RelayOffer, store: MemoryDeviceStore,
  compare?: (digits: string) => Promise<void>, relays?: readonly string[]) {
  let session: RelaySession | undefined;
  let socket: FakeSocket;
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => socket.deliver(data),
    // as on a WebSocket, the PC's close reaches the phone in a later task than the frames it sent first
    close: (code, reason) => { setImmediate(() => socket.close(code, reason)); },
  };
  socket = new FakeSocket(daemon);
  // frames the phone sends as soon as its side opens wait for the session, as a relay's latency would make them
  const early: (string | ArrayBuffer)[] = [];
  void openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: { onmessage: (data) => { if (session) session.receive(data); else early.push(data); } } }).then((channel) => {
    session = new RelaySession({
      channel, services: f.app.context.services, port: f.app.port, serverId: offer.server_id, serverVersion: "0.4.20",
      minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
      ...(relays ? { relayHints: () => relays } : {}),
    });
    for (const data of early.splice(0)) session.receive(data);
  }, () => {});
  const opening = openRelayChannel(offer, {
    store, ...(compare ? { compare } : {}),
    socket: () => {
      queueMicrotask(() => socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) })));
      return socket;
    },
  });
  void opening.catch(() => {});
  return opening;
}

async function comparing(compare: (digits: string) => Promise<void>) {
  const f = relayFixture();
  cleanups.push(() => f.close());
  // as copying a link without a code does
  f.app.context.services.relay.approvals.openWindow();
  const keys = generateKeyPair();
  const store = new MemoryDeviceStore();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  const waiting = Promise.withResolvers<RelayPairingRequest>();
  const cleared = Promise.withResolvers<void>();
  let seen = false;
  cleanups.push(f.app.context.services.relay.approvals.subscribe((list) => {
    if (list[0]) { seen = true; waiting.resolve(list[0]); } else if (seen) cleared.resolve();
  }));
  const opening = connectReal(f, keys, offer, store, compare);
  return { f, store, offer, opening, waiting: bounded(waiting.promise), cleared: bounded(cleared.promise) };
}

it("pairs again with a new code a phone that already holds a key for the PC", async () => {
  const f = relayFixture();
  cleanups.push(() => f.close());
  const keys = generateKeyPair();
  const store = new MemoryDeviceStore();
  const base = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  const devices = f.app.context.services.devices;
  const first = await bounded(connectReal(f, keys, { ...base, code: devices.startPairing().code }, store));
  first.close();
  // a fresh QR code scanned on the same phone: the PC makes a new device for the same key, and the phone keeps it
  const second = await bounded(connectReal(f, keys, { ...base, code: devices.startPairing().code }, store));
  cleanups.push(() => second.close());
  expect(second.device.device_id).not.toBe(first.device.device_id);
  expect((await store.get(base.server_id))?.device_id).toBe(second.device.device_id);
});

it("pairs a new device without a code once both screens show the same digits and the PC approves it", async () => {
  const shown = Promise.withResolvers<string>();
  const matched = Promise.withResolvers<void>();
  const { f, store, offer, opening, waiting } = await comparing((digits) => { shown.resolve(digits); return matched.promise; });
  const request = await waiting;
  expect(await bounded(shown.promise)).toBe(request.digits);
  expect(f.app.context.services.relay.approvals.decide(request.id, true)).toBe(true);
  matched.resolve();
  const channel = await bounded(opening);
  cleanups.push(() => channel.close());
  const saved = await store.get(offer.server_id);
  expect(saved?.device_id).toBe(channel.device.device_id);
  expect(f.app.context.services.devices.list(null).find((device) => device.id === saved?.device_id)?.via_relay).toBe(true);
});

it("saves no key when the PC declines, and lands on the not-approved screen", async () => {
  const { f, store, offer, opening, waiting, cleared } = await comparing(() => new Promise(() => {}));
  const request = await waiting;
  expect(f.app.context.services.relay.approvals.decide(request.id, false)).toBe(true);
  const error = await bounded(opening.then(() => null, (reason: unknown) => reason));
  expect(error).toBeInstanceOf(MuxProtocolError);
  expect(failureOf(error, { code: false, paired: false, compared: true })).toBe("pair-declined");
  expect(await store.get(offer.server_id)).toBeUndefined();
  await cleared;
});

it("does not take AUTH_OK from a PC before this phone said the digits match", async () => {
  const keys = generateKeyPair();
  let socket: FakeSocket;
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => socket.deliver(data),
    close: (code, reason) => { setImmediate(() => socket.close(code, reason)); },
  };
  socket = new FakeSocket(daemon);
  const ready = Promise.withResolvers<SecureChannel>();
  const send = (frame: MuxFrame) => ready.promise.then((channel) => channel.send(encodeFrame(frame).slice().buffer));
  // a PC endpoint that skips the comparison: it admits the phone as soon as the phone reveals its nonce
  void openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: { onmessage: (data) => {
    const frame = decodeFrame(new Uint8Array(data as ArrayBuffer));
    if (frame.type === FrameType.HELLO) void send({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", version: 1,
      features: ["pair-sas"], limits: LIMITS_V1, nonce: base64url(new Uint8Array(32)), server_version: "0.4.21", relay_protocol: 1, min_supported_client: "0.4.20" } });
    if (frame.type === FrameType.PAIR_REQUEST) void send({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: base64url(new Uint8Array(32).fill(7)) } });
    if (frame.type === FrameType.PAIR_REVEAL) void send({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0, payload: { session_id: "ab".repeat(16), device_id: "cd".repeat(8), role: "drive" } });
  } } }).then((channel) => ready.resolve(channel), () => {});
  const store = new MemoryDeviceStore();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  const shown = Promise.withResolvers<void>();
  const opening = openRelayChannel(offer, { store, compare: () => { shown.resolve(); return new Promise(() => {}); },
    socket: () => { queueMicrotask(() => socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return socket; } });
  cleanups.push(() => socket.close());
  const error = await bounded(opening.then(() => null, (reason: unknown) => reason));
  await bounded(shown.promise);
  expect(error).toBeInstanceOf(MuxProtocolError);
  expect((error as MuxProtocolError).code).toBe("protocol_error");
  expect(await store.get(offer.server_id)).toBeUndefined();
});

it("a phone the PC removed is refused at sign-in from a link without a code, and pairs by digits once its old key is gone", async () => {
  const f = relayFixture();
  cleanups.push(() => f.close());
  f.app.context.services.relay.approvals.openWindow();
  const keys = generateKeyPair();
  const store = new MemoryDeviceStore();
  const base = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  const devices = f.app.context.services.devices;
  const first = await bounded(connectReal(f, keys, { ...base, code: devices.startPairing().code }, store));
  first.close();
  devices.revoke(first.device.device_id!);
  const shown = Promise.withResolvers<string>();
  const compare = (digits: string) => { shown.resolve(digits); return Promise.resolve(); };
  // what the shell gets from the first try: the PC's refusal of the old key (shellState.ts pairsAgainWithoutKey)
  const refused = await bounded(connectReal(f, keys, base, store, compare).then(() => null, (reason: unknown) => reason));
  expect(pairsAgainWithoutKey(refused, { code: false, paired: false, codeless: true })).toBe(true);
  await store.remove(base.server_id);
  const waiting = Promise.withResolvers<RelayPairingRequest>();
  cleanups.push(f.app.context.services.relay.approvals.subscribe((list) => { if (list[0]) waiting.resolve(list[0]); }));
  const again = connectReal(f, keys, base, store, compare);
  const request = await bounded(waiting.promise);
  expect(await bounded(shown.promise)).toBe(request.digits);
  f.app.context.services.relay.approvals.decide(request.id, true);
  const channel = await bounded(again);
  cleanups.push(() => channel.close());
  expect((await store.get(base.server_id))?.device_id).toBe(channel.device.device_id);
});

it("saves the regional relay a real PC names after its provisional WELCOME", async () => {
  const f = relayFixture();
  cleanups.push(() => f.close());
  const keys = generateKeyPair();
  const store = new MemoryDeviceStore();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: GLOBAL_RELAY,
    code: f.app.context.services.devices.startPairing().code };
  const channel = await bounded(connectReal(f, keys, offer, store, undefined, [REGIONAL, GLOBAL_RELAY]));
  cleanups.push(() => channel.close());
  expect((await store.get(offer.server_id))?.relay).toBe(REGIONAL);
});
