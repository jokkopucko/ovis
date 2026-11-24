import { afterEach, describe, expect, it, jest } from "bun:test";
import { PENDING_MS } from "../../../server/account/pending.ts";
import { LIST_ALLOW_MS } from "../../../server/account/list-follow.ts";
import { PAIR_APPROVAL_MS } from "../../../shared/relay-pair-sas.ts";
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
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG } from "../../../relay/core.ts";
import type { MuxFrame } from "../../../shared/relay-mux.ts";
import { MuxEngine } from "../../../shared/relay-mux-engine.ts";
import type { RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { withAccountDevice } from "../account/accountDevice.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE } from "../../../shared/relay-mux.ts";
import { pairFingerprint, verifyPairProof } from "../../../shared/pair-fingerprint.ts";
import { ADMISSION_MS, ASSIGNMENT_MS, openRelayChannel, PC_ANSWER_MS, RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayPcOfflineError, RelayUnreachableError } from "./channel.ts";
import { AccountListUnsupportedError, ListMismatchError, probePc } from "../../../shared/relay-channel.ts";
import { deviceCard, deviceListKeys } from "../account/listKeys.ts";
import { memoryAccountStore } from "../account/store.ts";
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
  /** when each frame was put on this socket, by `clock`, and how many were the relay's own keepalive */
  readonly sentAt: number[] = [];
  pings = 0;
  clock: () => number = () => 0;
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    // a browser socket in CLOSING drops what it is given, without an error
    if (this.closing) return;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.sentAt.push(this.clock());
    // the relay answers its own keepalive (relay/core.ts), and the PC behind it never sees it
    if (data === KEEPALIVE_PING) { this.pings += 1; queueMicrotask(() => this.deliver(KEEPALIVE_PONG)); return; }
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

async function fixture(pairing: boolean, attack?: "welcome" | "nonce" | "ping" | "auth-ok" | "features" | "assigned" | "receipt" | "silence" | "protocol" | "early-welcome" | "account" | "key-proof" | "key-proof-twice", onClose?: (error: Error) => void,
  pc: { relay?: string; hints?: readonly string[]; features?: readonly string[]; provisional?: boolean; omitKeyPending?: boolean; wrap?: (store: MemoryDeviceStore, device: RelayDevice) => RelayDeviceStore } = {}, channel: Partial<RelayChannelOptions> = {}) {
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
  const receiptSeen = Promise.withResolvers<MuxEngine["stats"]>();
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
      incoming = incoming.then(async () => {
        await daemonOpening;
        server.receive(bytes);
        if (frame.type === FrameType.RECEIVED) receiptSeen.resolve(server.stats);
      }).catch(fail);
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
    if (pc.provisional) {
      server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { ...welcome(), features: [], provisional: true } });
    } else if (attack === "early-welcome") {
      trace.push("server:WELCOME");
      server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: welcome() });
    }
  });
  void daemonOpening.catch(() => {});
  const welcome = () => ({ protocol: "ovis-mux" as const, version: 1 as const, features: pc.features ?? (attack === "features" ? ["unoffered"] : attack === "account" ? ["account"] : []),
    limits: { ...LIMITS_V1, max_streams: 2 }, nonce: attack === "nonce" ? base64url(nonce.slice(1)) : base64url(nonce),
    server_version: "test", relay_protocol: attack === "protocol" ? 2 : 1, min_supported_client: "0.0.0" });
  const raw = (type: number, payload: unknown): Uint8Array => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(8 + body.length);
    bytes[0] = 1; bytes[1] = type; bytes.set(body, 8);
    return bytes;
  };
  let keyProofSent: MuxFrame | undefined;
  const keyProof = { challenge: base64url(new Uint8Array(32).fill(7)), proved: Promise.withResolvers<string>(), proofs: 0 };
  const handle = async (frame: MuxFrame): Promise<void> => {
    if (frame.type === FrameType.KEY_PROVE) {
      keyProof.proofs++;
      keyProof.proved.resolve(frame.payload.signature);
      if (attack === "key-proof-twice") {
        await secure.send(raw(FrameType.KEY_CHALLENGE, { challenge: base64url(new Uint8Array(32).fill(8)) }).slice().buffer);
        return;
      }
      // a waiting frame that tries to name a fingerprint: the device must never show it
      if (!pc.omitKeyPending) await secure.send(raw(FrameType.KEY_PENDING, { fingerprint: "ZZZZ-ZZZZ" }).slice().buffer);
      return;
    }
    if (frame.type === FrameType.HELLO) {
      offered = frame.payload.features;
      hinting = pc.hints !== undefined && offered.includes("relay-hints");
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
    if (frame.type === FrameType.PAIR && (attack === "key-proof" || attack === "key-proof-twice") && offered.includes("key-proof-1") && !keyProofSent) {
      keyProofSent = frame;
      await secure.send(raw(FrameType.KEY_CHALLENGE, { challenge: keyProof.challenge, fingerprint: "ZZZZ-ZZZZ" }).slice().buffer);
      await keyProof.proved.promise;
    }
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
  const signingIn = !pairing && pc.wrap ? (await store.get(offer.server_id))! : undefined;
  const opening = openRelayChannel(offer, { ...channel, store: signingIn ? pc.wrap!(store, signingIn) : store, ...(onClose ? { onClose } : {}), socket: (url) => {
    expect(url).toBe(`${offer.relay}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
    queueMicrotask(() => socket.deliver(JSON.stringify(attack === "assigned" ? { type: "wrong" } : { type: "assigned", connection_id: "ef".repeat(16) })));
    return socket;
  } });
  return { opening, trace, authSeen, allowAuth, httpSeen, receiptSeen, socket, store, offer, keyProof, get offered() { return offered; } };
}

for (const pairing of [false, true]) {
  it(`sends only HELLO and ${pairing ? "PAIR" : "AUTH"} until AUTH_OK through real Noise and mux`, async () => {
    const f = await fixture(pairing);
    await f.authSeen.promise;
    expect(f.trace).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`]);
    f.allowAuth.resolve();
    const channel = await f.opening;
    expect(channel.device.device_id).toBe((await f.store.get(f.offer.server_id))?.device_id ?? null);
    expect(channel.connectionId).toBe("ef".repeat(16));
    expect(channel.mux.limits.max_streams).toBe(2);
    expect(channel.server).toEqual({ version: "test", relayProtocol: 1, features: [], minSupportedClient: "0.0.0" });
    expect(f.trace.slice(0, 4)).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`, "server:AUTH_OK"]);
    console.log(`ORDER: ${f.trace.slice(0, 4).join(" -> ")}; no other client frame before AUTH_OK`);
    channel.mux.openHttp({ method: "GET", target: "/api/test", headers: [], body: "none" });
    expect(await f.httpSeen.promise).toBe("/api/test");
    channel.close();
  });

  it(`signs in with ${pairing ? "PAIR" : "AUTH"} on a WELCOME the PC sent without waiting for HELLO`, async () => {
    const f = await fixture(pairing, "early-welcome");
    await f.authSeen.promise;
    expect(f.trace.filter((entry) => entry === "server:WELCOME")).toHaveLength(1);
    expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(["client:HELLO", `client:${pairing ? "PAIR" : "AUTH"}`]);
    f.allowAuth.resolve();
    const channel = await f.opening;
    expect(channel.server).toEqual({ version: "test", relayProtocol: 1, features: [], minSupportedClient: "0.0.0" });
    channel.mux.openHttp({ method: "GET", target: "/api/test", headers: [], body: "none" });
    expect(await f.httpSeen.promise).toBe("/api/test");
    channel.close();
  });
}

it("ends an admitted channel whose socket is closing, rather than sending into it", async () => {
  const lost = Promise.withResolvers<Error>();
  const f = await fixture(false, undefined, (error) => lost.resolve(error));
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect(channel.carrierOpen).toBe(true);
  f.socket.closing = true;
  expect(channel.carrierOpen).toBe(false);
  channel.mux.openHttp({ method: "GET", target: "/api/lost", headers: [], body: "none" });
  expect(await bounded(lost.promise, 2000)).toBeInstanceOf(MuxProtocolError);
  expect(f.socket.closed).toBe(true);
});

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

function settled(promise: Promise<unknown>): { get(): { error: unknown } | null } {
  let result: { error: unknown } | null = null;
  promise.then(() => { result = { error: null }; }, (error: unknown) => { result = { error }; });
  return { get: () => result };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

it("calls a relay that never assigns the connection unreachable, after ASSIGNMENT_MS", async () => {
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  jest.advanceTimersByTime(ASSIGNMENT_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayUnreachableError);
  expect(error).toMatchObject({ closeCode: null, silent: true });
  expect(failureOf(error, { code: true, paired: false })).toBe("relay-unreachable");
  expect(socket.closed).toBe(4000);
});

it("calls a relay that turned this device away before assigning it (TRY_AGAIN, POLICY) a refusal, and a socket that failed saying nothing unreachable", async () => {
  const failure = async (code: number) => {
    const socket = new SilentSocket();
    const created = Promise.withResolvers<void>();
    const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
    const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
    await created.promise;
    socket.onclose?.(new CloseEvent("close", { code, reason: "too many clients for this server" }));
    await flush();
    return failureOf(outcome.get()?.error, { code: false, paired: true });
  };
  expect([await failure(1013), await failure(1008), await failure(1006), await failure(1011)]).toEqual(["relay-refused", "relay-refused", "relay-unreachable", "relay-unreachable"]);
});

it("tells a probe's PC that never came from a relay that turned this device away before assigning it and from a carrier that failed saying nothing", async () => {
  jest.useFakeTimers();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const probed = async (act: (socket: SilentSocket) => void) => {
    const socket = new SilentSocket();
    const found = probePc(offer, { relay: offer.relay }, () => socket, 8_000);
    act(socket);
    await flush();
    jest.advanceTimersByTime(8_000);
    return (await found).kind;
  };
  const assigned = (socket: SilentSocket): void => socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  const closed = (socket: SilentSocket, code: number): void => socket.onclose?.(new CloseEvent("close", { code }));
  expect({
    nobody: await probed(assigned),
    pcGone: await probed((socket) => { assigned(socket); closed(socket, 1012); }),
    busyBefore: await probed((socket) => closed(socket, 1013)),
    policy: await probed((socket) => closed(socket, 1008)),
    dropped: await probed((socket) => { assigned(socket); closed(socket, 1006); }),
    failed: await probed((socket) => { assigned(socket); socket.onerror?.(new Event("error")); }),
    unassigned: await probed((socket) => closed(socket, 1011)),
  }).toEqual({ nobody: "silent", pcGone: "silent", busyBefore: "refused", policy: "refused", dropped: "unreachable", failed: "unreachable", unassigned: "unreachable" });
});

it("calls the PC offline when the relay assigned the connection but nothing answered within PC_ANSWER_MS", async () => {
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  await socket.sent.promise;
  jest.advanceTimersByTime(ASSIGNMENT_MS);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(PC_ANSWER_MS - ASSIGNMENT_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayPcOfflineError);
  expect(error).toBeInstanceOf(MuxProtocolError);
  expect(error).toMatchObject({ code: "timeout" });
  expect(failureOf(error, { code: false, paired: true })).toBe("pc-offline");
  expect(socket.closed).toBe(4000);
});

it("names the relay's refusal of a new device (4403), on a code and on compared digits alike, and tries no further", async () => {
  const run = async (code: number) => {
    const socket = new SilentSocket();
    const created = Promise.withResolvers<void>();
    const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example", code: "ABCD-EFGH" };
    const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), socket: () => { created.resolve(); return socket; } }));
    await created.promise;
    socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
    await socket.sent.promise;
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
  const lost = await run(1001);
  expect(lost).toBeInstanceOf(MuxProtocolError);
  expect(failureOf(lost, { code: true, paired: false })).toBe("pc-offline");
  expect(isFatalRelayError(lost)).toBe(false);
});

it("waits for the PC as long as pcAnswerMs says, for a reconnect behind the app", async () => {
  jest.useFakeTimers();
  const socket = new SilentSocket();
  const created = Promise.withResolvers<void>();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const outcome = settled(openRelayChannel(offer, { store: new MemoryDeviceStore(), pcAnswerMs: 25_000, socket: () => { created.resolve(); return socket; } }));
  await created.promise;
  socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }));
  await socket.sent.promise;
  jest.advanceTimersByTime(PC_ANSWER_MS);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(25_000 - PC_ANSWER_MS);
  await flush();
  expect(outcome.get()?.error).toBeInstanceOf(RelayPcOfflineError);
});

it("calls a PC that answered the handshake but never finished admission unresponsive, not offline", async () => {
  jest.useFakeTimers();
  const f = await fixture(false, "silence");
  const outcome = settled(f.opening);
  for (let i = 0; i < 200 && !f.trace.includes("client:HELLO"); i++) await Promise.resolve();
  expect(f.trace).toEqual(["client:HELLO"]);
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
  jest.useFakeTimers();
  const f = await fixture(true, "silence");
  const outcome = settled(f.opening);
  for (let i = 0; i < 200 && !f.trace.includes("client:HELLO"); i++) await Promise.resolve();
  jest.advanceTimersByTime(ADMISSION_MS);
  await flush();
  // Then the attempt failed and this PC's slot is still empty: a later real QR pairs without a warning.
  expect(outcome.get()?.error).toBeInstanceOf(RelayAdmissionTimeoutError);
  expect(await f.store.list()).toEqual([]);
});

it("names a stall after WELCOME in the auth phase, within the same admission budget", async () => {
  jest.useFakeTimers();
  const f = await fixture(false);
  const outcome = settled(f.opening);
  await f.authSeen.promise;
  expect(f.trace).toEqual(["client:HELLO", "server:WELCOME", "client:AUTH"]);
  jest.advanceTimersByTime(ADMISSION_MS - 1);
  await flush();
  expect(outcome.get()).toBeNull();
  jest.advanceTimersByTime(1);
  await flush();
  const error = outcome.get()?.error;
  expect(error).toBeInstanceOf(RelayAdmissionTimeoutError);
  expect(error).toMatchObject({ phase: "auth" });
  expect(failureOf(error, { code: false, paired: true })).toBe("pc-unresponsive");
  expect(f.socket.closed).toBe(true);
});

it("stops at a PC of another relay protocol before any credential, as an update", async () => {
  const f = await fixture(false, "protocol");
  const error = await f.opening.catch((caught: unknown) => caught);
  // Then the attempt ends on the update screen and no AUTH was sent.
  expect(error).toMatchObject({ code: "unsupported_version" });
  expect(failureOf(error, { code: false, paired: true })).toBe("needs-update");
  expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(["client:HELLO"]);
  expect(f.socket.closed).toBe(true);
});

it("G5: does not send account AUTH when WELCOME selects no account-open feature", async () => {
  const old = await fixture(false, undefined, undefined, {}, { accountOpensAll: true });
  old.allowAuth.resolve();
  await expect(old.opening).rejects.toThrow();
  expect(old.trace).toEqual(["client:HELLO", "server:WELCOME"]);
});

it("T34, G5: offers the account-opens-all mux feature in HELLO only when asked, so only a flag-on app hears an account refusal", async () => {
  const plain = await fixture(false);
  await plain.authSeen.promise;
  expect(plain.offered).not.toContain(ACCOUNT_OPENS_ALL_FEATURE);
  plain.allowAuth.resolve();
  await plain.opening;
  const asking = await fixture(false, undefined, undefined, { features: [ACCOUNT_OPENS_ALL_FEATURE] }, { accountOpensAll: true });
  await asking.authSeen.promise;
  expect(asking.offered).toContain(ACCOUNT_OPENS_ALL_FEATURE);
  asking.allowAuth.resolve();
  await asking.opening;
});

it("offers the account-list feature on every sign-in that is no pairing, so a pinned PC can say which key it wants", async () => {
  const plain = await fixture(false);
  await plain.authSeen.promise;
  expect(plain.offered).toContain(ACCOUNT_LIST_FEATURE);
  expect(plain.offered).not.toContain(ACCOUNT_OPENS_ALL_FEATURE);
  plain.allowAuth.resolve();
  await plain.opening;
  // a pairing by code offers none of it: no device is named yet
  const pairing = await fixture(true);
  pairing.allowAuth.resolve();
  await pairing.opening;
  expect(pairing.offered).not.toContain(ACCOUNT_LIST_FEATURE);
});

it("signs in with the list key only to a PC whose final WELCOME says that it follows a list, and offers the account open beside it", async () => {
  const pinned = await fixture(false, undefined, undefined, { provisional: true, features: [ACCOUNT_LIST_FEATURE] }, { accountListKey: true });
  await pinned.authSeen.promise;
  expect(pinned.offered).toEqual(expect.arrayContaining([ACCOUNT_LIST_FEATURE, ACCOUNT_OPENS_ALL_FEATURE]));
  pinned.allowAuth.resolve();
  await pinned.opening;
  // a PC that follows no list selects nothing: no AUTH goes out, and the caller is told which it was
  const plain = await fixture(false, undefined, undefined, {}, { accountListKey: true });
  plain.allowAuth.resolve();
  await expect(plain.opening).rejects.toBeInstanceOf(AccountListUnsupportedError);
  expect(plain.trace).toEqual(["client:HELLO", "server:WELCOME"]);
});

it("T34: an account open after a provisional WELCOME acknowledges every PC setup frame", async () => {
  const f = await fixture(false, undefined, undefined, { provisional: true, features: [ACCOUNT_OPENS_ALL_FEATURE] }, { accountOpensAll: true });
  f.allowAuth.resolve();
  const channel = await f.opening;
  await channel.mux.flush();
  const { acknowledged, submitted } = await bounded(f.receiptSeen.promise);
  expect(submitted).toBe(3n);
  expect(acknowledged).toBe(submitted);
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
    const f = await fixture(false, attack);
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

it("tells the comparison which PC approves it on its own screen, any PC it cannot name being a PC", async () => {
  for (const [sent, told] of [["mac", "mac"], ["windows", "windows"], ["linux", "linux"], ["toaster", "pc"], [undefined, undefined]] as const) {
    const keys = generateKeyPair();
    let socket: FakeSocket;
    const daemon: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => socket.deliver(data),
      close: (code, reason) => { setImmediate(() => socket.close(code, reason)); },
    };
    socket = new FakeSocket(daemon);
    const ready = Promise.withResolvers<SecureChannel>();
    // a PC endpoint that sends its challenge as JSON of its own, so a value this phone does not know can be sent
    const send = (frame: MuxFrame, extra: Record<string, unknown> = {}) => ready.promise.then((channel) => {
      const bytes = encodeFrame(frame);
      if (Object.keys(extra).length === 0) return channel.send(bytes.slice().buffer);
      const json = new TextDecoder().decode(bytes.subarray(8));
      const patched = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(json) as object, ...extra }));
      const out = new Uint8Array(8 + patched.length);
      out.set(bytes.subarray(0, 8));
      out.set(patched, 8);
      return channel.send(out.buffer);
    });
    void openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: { onmessage: (data) => {
      const frame = decodeFrame(new Uint8Array(data as ArrayBuffer));
      if (frame.type === FrameType.HELLO) void send({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", version: 1,
        features: ["pair-sas"], limits: LIMITS_V1, nonce: base64url(new Uint8Array(32)), server_version: "0.4.21", relay_protocol: 1, min_supported_client: "0.4.20" } });
      if (frame.type === FrameType.PAIR_REQUEST) void send({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: base64url(new Uint8Array(32).fill(7)) } }, sent === undefined ? {} : { approve_on: sent });
    } } }).then((channel) => ready.resolve(channel), () => {});
    const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
    const shown = Promise.withResolvers<unknown>();
    const opening = openRelayChannel(offer, { store: new MemoryDeviceStore(), compare: (_digits, approveOn) => { shown.resolve(approveOn); return new Promise(() => {}); },
      socket: () => { queueMicrotask(() => socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return socket; } });
    void opening.catch(() => {});
    expect(await bounded(shown.promise)).toBe(told);
    socket.close();
  }
});

/**
 * A PC endpoint scripted for a join by digits: it selects `features`, answers the request with a challenge (with
 * `list` where it names the list it follows), and lets the device in once it confirmed, naming `place` in AUTH_OK.
 * `answers: false`: it never answers the confirmation, as a PC that waits for an entry of the list.
 */
function scriptedJoin(pc: { features: readonly string[]; list?: string; place?: { id: string; seq: number; hash: string }; answers?: false }) {
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
  const hello = Promise.withResolvers<readonly string[]>();
  const request = Promise.withResolvers<Record<string, unknown>>();
  const confirmed = Promise.withResolvers<void>();
  void openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: { onmessage: (data) => {
    const frame = decodeFrame(new Uint8Array(data as ArrayBuffer));
    if (frame.type === FrameType.HELLO) {
      hello.resolve(frame.payload.features);
      void send({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", version: 1,
        features: pc.features.filter((feature) => frame.payload.features.includes(feature)), limits: LIMITS_V1, nonce: base64url(new Uint8Array(32)), server_version: "0.4.21", relay_protocol: 1, min_supported_client: "0.4.20" } });
    }
    if (frame.type === FrameType.PAIR_REQUEST) {
      request.resolve(frame.payload as unknown as Record<string, unknown>);
      void send({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: base64url(new Uint8Array(32).fill(7)), ...(pc.list === undefined ? {} : { list: pc.list }) } });
    }
    if (frame.type === FrameType.PAIR_CONFIRM) {
      confirmed.resolve();
      if (pc.answers !== false) void send({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0, payload: { session_id: "ab".repeat(16), device_id: "cd".repeat(8), role: "drive", ...(pc.place === undefined ? {} : { list: pc.place }) } });
    }
  } } }).then((channel) => ready.resolve(channel), () => {});
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  const store = new MemoryDeviceStore();
  cleanups.push(() => socket.close());
  const open = (options: Partial<Parameters<typeof openRelayChannel>[1]>) => {
    const opening = openRelayChannel(offer, { store, intent: "account", compare: async () => {}, ...options,
      socket: () => { queueMicrotask(() => socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return socket; } });
    void opening.catch(() => {});
    return opening;
  };
  return { offer, store, open, socket, hello: bounded(hello.promise), request: bounded(request.promise), confirmed: confirmed.promise };
}

describe("a new device that joins through a PC pinned to its account's list", () => {
  const LIST = "5c".repeat(32);
  const OTHER = "6d".repeat(32);
  const card = async () => {
    const store = memoryAccountStore();
    const keys = await deviceListKeys(store);
    return { key: await store.key(), listCard: { list: LIST, enc: keys.enc.key, card: (await deviceCard(keys, LIST)).card } };
  };

  it("offers to bring its card only when it holds one, sends it only to a PC that took the offer, and is handed its place with no pairing saved", async () => {
    const { key, listCard } = await card();
    const place = { id: LIST, seq: 4, hash: "ab".repeat(32) };
    const pinned = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, place });
    const channel = await bounded(pinned.open({ accountKey: key, listCard }));
    cleanups.push(() => channel.close());
    expect(await pinned.hello).toContain(ACCOUNT_LIST_ALLOW);
    expect(await pinned.request).toMatchObject({ public_key: key.public_spki, list_enc: listCard.enc, list_card: listCard.card });
    expect(channel.listPlace).toEqual(place);
    // the key was let in by an entry of the list: no pairing of this device's own with the PC is kept
    expect(await pinned.store.get(pinned.offer.server_id)).toBeUndefined();
  });

  it("sends no card to a PC that did not take the offer, and pairs there as before", async () => {
    const { key, listCard } = await card();
    const plain = scriptedJoin({ features: ["pair-sas"] });
    const channel = await bounded(plain.open({ accountKey: key, listCard }));
    cleanups.push(() => channel.close());
    const request = await plain.request;
    expect(["list_enc" in request, "list_card" in request, channel.listPlace]).toEqual([false, false, undefined]);
    expect((await plain.store.get(plain.offer.server_id))?.device_id).toBe("cd".repeat(8));
  });

  it("offers nothing of a list where it holds no card, or asks for that PC only", async () => {
    const { key, listCard } = await card();
    const none = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST });
    void none.open({ accountKey: key });
    expect(await none.hello).not.toContain(ACCOUNT_LIST_ALLOW);
    const pcOnly = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST });
    void pcOnly.open({ accountKey: key, listCard, intent: "pc" });
    expect(await pcOnly.hello).not.toContain(ACCOUNT_LIST_ALLOW);
  });

  it("stops before it shows any digits where the PC follows another list than the one its card names", async () => {
    const { key, listCard } = await card();
    const other = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: OTHER });
    let shown = false;
    const error = await bounded(other.open({ accountKey: key, listCard, compare: async () => { shown = true; } }).then(() => null, (reason: unknown) => reason));
    expect(error).toBeInstanceOf(ListMismatchError);
    expect(shown).toBe(false);
    expect(await other.store.get(other.offer.server_id)).toBeUndefined();
  });

  it("takes no place from a PC that did not take the offer, and none that names another list than its card's", async () => {
    const { key, listCard } = await card();
    const unasked = scriptedJoin({ features: ["pair-sas"], place: { id: LIST, seq: 4, hash: "ab".repeat(32) } });
    const paired = await bounded(unasked.open({ accountKey: key, listCard }));
    cleanups.push(() => paired.close());
    expect(paired.listPlace).toBeUndefined();
    const lying = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, place: { id: OTHER, seq: 4, hash: "ab".repeat(32) } });
    const error = await bounded(lying.open({ accountKey: key, listCard }).then(() => null, (reason: unknown) => reason));
    expect(error).toBeInstanceOf(ListMismatchError);
    expect(await lying.store.get(lying.offer.server_id)).toBeUndefined();
  });

  it("tells the comparison that a join the PC took the card for is one into the list, which only the person's own press confirms; any other join is told nothing new", async () => {
    const { key, listCard } = await card();
    const told: unknown[][] = [];
    const pinned = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, place: { id: LIST, seq: 4, hash: "ab".repeat(32) } });
    const joined = await bounded(pinned.open({ accountKey: key, listCard, compare: async (...args) => { told.push(args); } }));
    cleanups.push(() => joined.close());
    const plain = scriptedJoin({ features: ["pair-sas"] });
    const paired = await bounded(plain.open({ accountKey: key, listCard, compare: async (...args) => { told.push(args); } }));
    cleanups.push(() => paired.close());
    expect(told).toEqual([[expect.any(String), undefined, true], [expect.any(String), undefined, undefined]]);
  });

  it("is refused, with nothing saved, by a PC that took its card and lets it in naming no place in the list", async () => {
    const { key, listCard } = await card();
    const placeless = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST });
    const error = await bounded(placeless.open({ accountKey: key, listCard }).then(() => null, (reason: unknown) => reason));
    expect(error instanceof MuxProtocolError && [error.code, error.message]).toEqual(["auth_failed", "list_refused"]);
    expect(failureOf(error, { code: false, paired: false, codeless: true, compared: true })).toBe("list-refused");
    expect(await placeless.store.get(placeless.offer.server_id)).toBeUndefined();
  });

  it("waits for the PC's entry as long as the PC may take for it after the comparison, where a join without a card ends at the comparison's own time", async () => {
    jest.useFakeTimers();
    const { key, listCard } = await card();
    const outcomes: { carded: boolean; error: unknown }[] = [];
    const waits = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, answers: false });
    void waits.open({ accountKey: key, listCard }).then(() => null, (error: unknown) => { outcomes.push({ carded: true, error }); });
    const plain = scriptedJoin({ features: ["pair-sas"], answers: false });
    void plain.open({ accountKey: key, listCard }).then(() => null, (error: unknown) => { outcomes.push({ carded: false, error }); });
    await Promise.all([waits.confirmed, plain.confirmed]);
    const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
    jest.advanceTimersByTime(PAIR_APPROVAL_MS + 5_000);
    await settle();
    expect(outcomes.map((each) => [each.carded, each.error instanceof RelayAdmissionTimeoutError])).toEqual([[false, true]]);
    // the comparison's time, and the PC's own wait for the entry after both said yes
    jest.advanceTimersByTime(LIST_ALLOW_MS - 1);
    await settle();
    expect(outcomes).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(outcomes.map((each) => [each.carded, each.error instanceof RelayAdmissionTimeoutError])).toEqual([[false, true], [true, true]]);
  });

  it("keeps its relay socket from going idle for the whole wait with the relay's own keepalive, which no PC sees; a join without a card sends none", async () => {
    jest.useFakeTimers();
    let elapsed = 0;
    const { key, listCard } = await card();
    const outcomes: boolean[] = [];
    const waits = scriptedJoin({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, answers: false });
    const plain = scriptedJoin({ features: ["pair-sas"], answers: false });
    for (const each of [waits, plain]) each.socket.clock = () => elapsed;
    void waits.open({ accountKey: key, listCard }).then(() => null, () => { outcomes.push(true); });
    void plain.open({ accountKey: key, listCard }).then(() => null, () => { outcomes.push(false); });
    await Promise.all([waits.confirmed, plain.confirmed]);
    const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
    // the person pressed at once; the PC answers nothing until the join's own deadline
    while (outcomes.length < 2) {
      jest.advanceTimersByTime(5_000);
      elapsed += 5_000;
      await settle();
    }
    expect(outcomes).toEqual([false, true]);
    expect(elapsed).toBeGreaterThan(IDLE_MS);
    // never as long as the relay's idle limit without a frame, from the confirm to the end of the wait; and the PC was
    // sent nothing it did not ask for
    const gaps = [...waits.socket.sentAt, elapsed].map((at, index, all) => index === 0 ? 0 : at - all[index - 1]!);
    expect(Math.max(...gaps)).toBeLessThan(IDLE_MS);
    expect([waits.socket.pings > 0, plain.socket.pings]).toEqual([true, 0]);
  });
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

it("T34, T40: a sign-in through the account row's store completes, and the row keeps its key and id", async () => {
  const f = await fixture(false, undefined, undefined, { hints: ["wss://relay2.example"], wrap: (_store, device) => withAccountDevice(new MemoryDeviceStore(), device) });
  await f.authSeen.promise;
  f.allowAuth.resolve();
  const channel = await f.opening;
  expect(channel).toBeDefined();
});

it.each([true, false])("T71, P11: only KEY_PENDING (%s) shows the fingerprint computed by the device", async (pending) => {
  const shown: string[] = [];
  const f = await fixture(true, "key-proof", undefined, { omitKeyPending: !pending }, { keyProof: (fingerprint) => { shown.push(fingerprint); } });
  const signature = await f.keyProof.proved.promise;
  await f.authSeen.promise;
  f.allowAuth.resolve();
  await f.opening;
  expect(f.offered).toContain("key-proof-1");
  const key = (await f.store.get(f.offer.server_id))!.public_spki;
  expect(await verifyPairProof(f.offer.server_id, f.keyProof.challenge, key, signature)).toBe(true);
  expect(shown).toEqual(pending ? [await pairFingerprint(f.offer.server_id, f.keyProof.challenge, key)] : []);
});

it("T71: approval just before the PC's pending-key deadline completes pairing", async () => {
  jest.useFakeTimers();
  const waiting = Promise.withResolvers<string>();
  const f = await fixture(true, "key-proof", undefined, {}, { keyProof: waiting.resolve });
  const outcome = f.opening.then((channel) => {
    channel.close();
    return "paired";
  }, (error: unknown) => error);
  await waiting.promise;
  await f.authSeen.promise;
  jest.advanceTimersByTime(PENDING_MS - 1);
  f.allowAuth.resolve();
  expect(await outcome).toBe("paired");
});

it("G5: without asking for key proof, HELLO does not offer it", async () => {
  const f = await fixture(true);
  await f.authSeen.promise;
  expect(f.offered).not.toContain("key-proof-1");
  f.allowAuth.resolve();
  await f.opening;
});

it("T72: a second challenge in the same pairing is never signed, and the attempt ends", async () => {
  const f = await fixture(true, "key-proof-twice", undefined, {}, { keyProof: () => {} });
  await f.keyProof.proved.promise;
  const error = await f.opening.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "protocol_error" });
  expect(f.keyProof.proofs).toBe(1);
});

it("stops waiting for the device store once the attempt is aborted, before any socket opens", async () => {
  const controller = new AbortController();
  const store: RelayDeviceStore = { get: () => new Promise<never>(() => {}), update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {} };
  let sockets = 0;
  const opening = openRelayChannel({ v: 1, server_id: "a".repeat(32), server_public_key: "key", code: "123456", relay: "wss://relay.example" },
    { store, signal: controller.signal, socket: () => { sockets++; throw new Error("No socket before the device is read"); } });
  controller.abort();
  expect(await bounded(opening.then(() => null, (error: unknown) => error), 2_000)).toMatchObject({ name: "AbortError" });
  expect(sockets).toBe(0);
});
