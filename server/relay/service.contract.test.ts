import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import { Room } from "../../relay/core.ts";
import { openClientSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { decodeOffer, validateOffer } from "../../shared/relay-offer.ts";
import { normalizePairCode, PairCodeExpiredError, PairCodeGuest, splitPairCode } from "../../shared/relay-pair-code.ts";
import { PAIR_CLOSE } from "../../relay/pair-room.ts";
import { offerFromCode } from "../../src/lib/relay/pairCode.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { HttpRequest, SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import type { RelayStatus, ServerMessage } from "../../shared/protocol.ts";
import { createServer } from "../index.ts";
import { loadRelayIdentity, relayIdentityPath } from "./identity.ts";
import { handleRelayRequest } from "./routes.ts";
import { RelayService } from "./service.ts";
import type { RelayServiceOptions } from "./service.ts";
import { bounded, deferred, TestClock } from "./test-helpers.ts";
import { relayClock } from "./session.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(serveOnly?: boolean, options: Partial<RelayServiceOptions> = {}) {
  let attempts = 0;
  const hostOptions = { port: 0, pairGuestGapMs: 0, limiters: {
    perAddress: { async limit() { attempts++; return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } };
  let localRelay = startBunRelay(hostOptions);
  cleanup.push(() => localRelay.stop());
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-service-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  let synced = deferred<void>();
  let controlLost = deferred<void>();
  let dataOpened = deferred<WebSocket>();
  /** every socket the PC opened, by kind, and what its control sockets heard */
  const opened: { kind: "control" | "data" | "warm"; socket: WebSocket }[] = [];
  const heard: string[] = [];
  const warmOpened: ReturnType<typeof deferred<WebSocket>>[] = [deferred<WebSocket>(), deferred<WebSocket>()];
  const relayOptions = {
    stateDir, relay: `wss://127.0.0.1:${localRelay.port}`,
    connect: (url: string) => {
      const target = new URL(url);
      const socket = new WebSocket(`ws://127.0.0.1:${localRelay.port}${target.pathname}${target.search}`);
      const kind = target.searchParams.has("connection_id") ? "data" : target.searchParams.has("warm") ? "warm" : "control";
      opened.push({ kind, socket });
      if (kind === "warm") {
        // resolved once the PC sent its proof: what the test sends after it reaches the relay after it
        const proved = warmOpened[opened.filter((entry) => entry.kind === "warm").length - 1];
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          send(data);
          if (typeof data === "string" && data.includes('"server_proof"')) proved?.resolve(socket);
        };
      }
      if (kind === "control") socket.addEventListener("message", (event) => { if (typeof event.data === "string") heard.push(event.data); });
      if (target.searchParams.has("connection_id")) {
        socket.addEventListener("open", () => dataOpened.resolve(socket));
      } else if (target.searchParams.has("warm")) {
        // a warm socket is a client's data socket from the moment the relay binds it
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string" && event.data.includes('"bound"')) dataOpened.resolve(socket);
        });
      } else socket.addEventListener("close", () => controlLost.resolve());
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
      return socket;
    }, ...options,
  };
  let service = new RelayService(relayOptions);
  let app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null,
    sidecar: false, tailscaleServeOnly: serveOnly, relay: service });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  return {
    stateDir,
    get localRelay() { return localRelay; },
    get app() { return app; },
    get service() { return service; },
    get attempts() { return attempts; },
    get dataOpened() { return dataOpened.promise; },
    get controlLost() { return controlLost.promise; },
    opened, heard, warmOpened: warmOpened.map((entry) => entry.promise),
    get base() { return `http://127.0.0.1:${app.port}`; },
    async request(path = "", method = "GET", guarded = true) {
      return fetch(this.base + "/api/relay" + path, { method,
        headers: { origin: this.base, ...(guarded ? { "x-herdr-update": "1" } : {}) } });
    },
    async start() {
      const response = await this.request("/start", "POST");
      expect(response.status).toBe(200);
      await bounded(synced.promise);
      expect((await (await this.request()).json() as RelayStatus).phase).toBe("online");
    },
    async offer() {
      const response = await this.request("/offer", "POST");
      expect(response.status).toBe(200);
      const result = await response.json() as { url: string; expires_at: string };
      expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now());
      const offer = decodeOffer(result.url);
      if (!offer) throw new Error("Offer missing");
      return offer;
    },
    async restart() {
      await service.shutdown();
      app.stop();
      synced = deferred<void>();
      service = new RelayService(relayOptions);
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
    },
    async interruptRelay(clock: TestClock) {
      synced = deferred<void>();
      const lost = controlLost.promise;
      await localRelay.stop();
      await bounded(lost);
      controlLost = deferred<void>();
      dataOpened = deferred<WebSocket>();
      localRelay = startBunRelay(hostOptions);
      expect(service.status().phase).toBe("error");
      clock.advance(999);
      const before = attempts;
      expect(service.status().phase).toBe("error");
      clock.advance(1);
      await bounded(synced.promise);
      expect(attempts).toBe(before + 1);
      expect(service.status().phase).toBe("online");
    },
  };
}

async function client(f: Awaited<ReturnType<typeof fixture>>, offer: RelayOffer, pair = true,
  device?: { id: string; keys: CryptoKeyPair }) {
  const socket = new WebSocket(`ws://127.0.0.1:${f.localRelay.port}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
  socket.binaryType = "arraybuffer";
  const assigned = deferred<void>();
  const closed = deferred<void>();
  const transport: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason),
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.includes('"assigned"')) { assigned.resolve(); return; }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  };
  socket.onclose = (event) => { transport.onclose?.(event.code, event.reason); closed.resolve(); };
  socket.onerror = () => transport.onerror?.(new Error("Test client connection failed"));
  cleanup.push(() => socket.close());
  await bounded(assigned.promise);
  const welcome = deferred<Extract<SessionFrame, { type: typeof FrameType.WELCOME }>>();
  const admitted = deferred<Extract<SessionFrame, { type: typeof FrameType.AUTH_OK }>>();
  const error = deferred<SessionError>();
  const goaway = deferred<{ code: string; last_open_id: number; drain_ms: number }>();
  let mux: MuxEngine | undefined;
  const channel = await bounded(openClientSecureChannel(transport, {
    daemonPublicKeyB64: offer.server_public_key,
    events: {
      onmessage: (data) => {
        if (typeof data === "string") throw new Error("Unencrypted application message");
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.SESSION_ERROR) error.resolve(frame.payload.code);
        if (frame.type === FrameType.GOAWAY) goaway.resolve(frame.payload);
        mux?.receive(new Uint8Array(data));
      },
      onclose: () => mux?.carrierLost(),
    },
  }));
  mux = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
    onSession: (frame) => {
      if (frame.type === FrameType.WELCOME) welcome.resolve(frame);
      if (frame.type === FrameType.AUTH_OK) { mux?.authenticate(frame.payload.device_id); admitted.resolve(frame); }
    },
  });
  const engine = mux;
  engine.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
  const greeting = (await bounded(welcome.promise)).payload;
  const keys = device?.keys ?? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  if (pair) {
    engine.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0,
      payload: { code: offer.code ?? "", label: "Service phone",
        public_key: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url") } });
  } else {
    if (!device) throw new Error("Device required");
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      Buffer.concat([Buffer.from("ovis-relay-auth/1"), Buffer.from(greeting.nonce, "base64url"), Buffer.from(offer.server_id)]))).toString("base64url");
    engine.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", device_id: device.id, signature } });
  }
  const principal = (await bounded(admitted.promise)).payload;
  return {
    device: { id: principal.device_id, keys }, error: error.promise, goaway: goaway.promise, closed: closed.promise, mux: engine,
    close: () => channel.close(),
    async http(target: string, init: Partial<Omit<HttpRequest, "target" | "device_id">> = {}) {
      const stream = engine.openHttp({ target, method: "GET", headers: [], body: "none", ...init });
      const response = deferred<Response>();
      stream.onHeaders = ({ status, headers }) => response.resolve(new Response(stream.noBody ? null : stream.body, {
        status, headers: headers.map(([name, value]) => [name, value]),
      }));
      stream.onDispose = (failure) => { if (failure) response.reject(failure); };
      return bounded(response.promise);
    },
    async ws() {
      const stream = engine.openWs({ target: "/ws", protocols: [], headers: [] });
      const opened = deferred<void>();
      const closed = deferred<number>();
      const pong = deferred<void>();
      stream.onAccept = () => opened.resolve();
      stream.onClose = ({ code }) => closed.resolve(code);
      stream.onMessage = (data) => {
        const message: ServerMessage = JSON.parse(String(data));
        if (message.type === "pong" && message.id === 12) pong.resolve();
      };
      await bounded(opened.promise);
      stream.send(JSON.stringify({ type: "ping", id: 12 }));
      await bounded(pong.promise);
      return { closed: closed.promise, stream };
    },
  };
}

/** A client that finishes the protected handshake and says hello, then never signs in or pairs. */
async function squatter(f: Awaited<ReturnType<typeof fixture>>, offer: RelayOffer) {
  const socket = new WebSocket(`ws://127.0.0.1:${f.localRelay.port}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
  socket.binaryType = "arraybuffer";
  const assigned = deferred<void>();
  const closed = deferred<void>();
  const transport: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason),
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.includes('"assigned"')) { assigned.resolve(); return; }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  };
  socket.onclose = (event) => { transport.onclose?.(event.code, event.reason); closed.resolve(); };
  cleanup.push(() => socket.close());
  await bounded(assigned.promise);
  const welcome = deferred<void>();
  let mux: MuxEngine | undefined;
  const channel = await bounded(openClientSecureChannel(transport, { daemonPublicKeyB64: offer.server_public_key,
    events: { onmessage: (data) => { if (typeof data !== "string") mux?.receive(new Uint8Array(data)); }, onclose: () => mux?.carrierLost() } }));
  mux = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
    onSession: (frame) => { if (frame.type === FrameType.WELCOME) welcome.resolve(); },
  });
  mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
  await bounded(welcome.promise);
  return { socket, closed: closed.promise };
}

it("relay off makes no connection", async () => {
  const f = await fixture();
  expect((await (await f.request()).json() as RelayStatus).phase).toBe("off");
  expect(f.attempts).toBe(0);
  expect(f.app.context.services.devices.gated).toBe(false);
});

it("reuses the active device pairing code for the relay offer", async () => {
  const f = await fixture();
  await f.start();
  const guard = { origin: f.base, "x-herdr-machine": "1" };
  const started = await fetch(`${f.base}/api/devices/pair/start`, { method: "POST", headers: guard });
  expect(started.status).toBe(200);
  const pairing = await started.json() as { code: string; expires_at: string };
  const response = await f.request("/offer", "POST");
  expect(response.status).toBe(200);
  const result = await response.json() as { url: string; expires_at: string };
  const offer = decodeOffer(result.url);
  if (!offer) throw new Error("Offer missing");
  expect(offer.code).toBe(pairing.code);
  expect(result.expires_at).toBe(pairing.expires_at);
  const paired = await fetch(`${f.base}/api/devices/pair`, {
    method: "POST", headers: { ...guard, "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, label: "CLI pairing" }),
  });
  expect(paired.status).toBe(204);
  const subsequentOffer = await f.offer();
  expect(f.app.context.services.devices.activePairing()?.code).toBe(subsequentOffer.code);
});

it("ends the relay offer's code, and a typed code, with the paired device that asked for it", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const devices = f.app.context.services.devices;
  const guard = { origin: f.base, "x-herdr-machine": "1" };
  // a device paired at this PC's own address, which asks with its own credential
  const pairHere = async (label: string) => {
    const paired = await fetch(`${f.base}/api/devices/pair`, {
      method: "POST", headers: { ...guard, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: devices.startPairing().code, label }),
    });
    expect(paired.status).toBe(200);
    const { token } = await paired.json() as { token: string };
    const id = devices.list(null).find((device) => device.label === label)!.id;
    const ask = (path: string) => fetch(`${f.base}/api/relay${path}`, { method: "POST", headers: { origin: f.base, "x-herdr-update": "1", authorization: `Device ${token}` } });
    return { id, ask };
  };
  // the offer it asks for starts a code: that code goes when the device is revoked
  const laptop = await pairHere("Laptop");
  expect(devices.activePairing()).toBeNull();
  expect((await laptop.ask("/offer")).status).toBe(200);
  expect(devices.activePairing()).not.toBeNull();
  devices.revoke(laptop.id);
  expect(devices.activePairing()).toBeNull();
  // so does this PC's own code once a device was handed it in an offer
  const tablet = await pairHere("Tablet");
  const own = await f.offer();
  const handed = decodeOffer((await (await tablet.ask("/offer")).json() as { url: string }).url);
  expect(handed?.code).toBe(own.code);
  devices.revoke(tablet.id);
  expect(devices.activePairing()).toBeNull();
  // and the code to type it asked for, with the six digits behind it
  const phone = await pairHere("Phone");
  expect((await phone.ask("/code")).status).toBe(200);
  expect(devices.activePairing()).not.toBeNull();
  devices.revoke(phone.id);
  expect(devices.activePairing()).toBeNull();
  // a code this PC asked for itself outlives the removal of a device that never had it
  const other = await pairHere("Other");
  const kept = await f.offer();
  devices.revoke(other.id);
  expect(devices.activePairing()?.code).toBe(kept.code);
  // a device revoked while its request was on its way is handed nothing and starts nothing
  for (const path of ["/api/relay/offer", "/api/relay/code"]) {
    const late = await handleRelayRequest(new Request(f.base + path, { method: "POST", headers: { origin: f.base, "x-herdr-update": "1" } }), path, f.app.context, other.id);
    expect([path, late.status, await late.json()]).toEqual([path, 401, { error: { code: "unauthorized", message: "this device is no longer paired" } }]);
  }
});

it("names the PC in the relay offer as Ovis lists it", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  expect(offer.name).toBe(hostname().slice(0, 64));
});

it("names the PC in the pairing link without a code as Ovis lists it", async () => {
  const f = await fixture();
  await f.start();
  const response = await f.request("/link", "POST");
  expect(response.status).toBe(200);
  const offer = decodeOffer((await response.json() as { url: string }).url);
  expect(offer?.code).toBeUndefined();
  expect(offer?.name).toBe(hostname().slice(0, 64));
});

it("closes the pairing window on request, and keeps it closed for the next start", async () => {
  const f = await fixture();
  await f.start();
  expect((await f.request("/link", "POST")).status).toBe(200);
  expect(f.service.approvals.windowOpen()).toBe(true);
  // Given the request does not come from this app's relay controls, it changes nothing
  expect((await f.request("/link/close", "POST", false)).status).toBe(403);
  expect(f.service.approvals.windowOpen()).toBe(true);
  // When the owner stops waiting
  const closed = await f.request("/link/close", "POST");
  expect(closed.status).toBe(200);
  expect(await closed.json()).toEqual({ ok: true });
  expect(f.service.approvals.windowOpen()).toBe(false);
  // Then a restart does not bring it back
  await f.restart();
  expect(f.service.approvals.windowOpen()).toBe(false);
  // And closing a window that is not open answers the same
  expect(await (await f.request("/link/close", "POST")).json()).toEqual({ ok: true });
});

it("keeps the pairing window, local-only as it was opened, across a restart", async () => {
  const f = await fixture();
  await f.start();
  const linked = await fetch(f.base + "/api/relay/link", { method: "POST", headers: { origin: f.base, "x-herdr-update": "1", "x-ovis-local-only": "1" } });
  expect(linked.status).toBe(200);
  await f.restart();
  expect(f.service.approvals.windowOpen()).toBe(true);
  expect(f.service.approvals.localOnlyOpen()).toBe(true);
});

it("closes the pairing window on Revoke all, Reset relay identity and turning the relay off", async () => {
  const f = await fixture();
  await f.start();
  const open = async () => {
    expect((await f.request("/link", "POST")).status).toBe(200);
    expect(f.service.approvals.windowOpen()).toBe(true);
  };
  const closedForGood = async () => {
    expect(f.service.approvals.windowOpen()).toBe(false);
    expect(f.service.approvals.localOnlyOpen()).toBe(false);
    expect(JSON.parse(readFileSync(join(f.stateDir, "relay", "pairing-window.json"), "utf8"))).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
  };
  await open();
  f.app.context.services.devices.revokeAll();
  await closedForGood();
  await open();
  await f.service.resetIdentity();
  await closedForGood();
  await open();
  expect((await f.request("/stop", "POST")).status).toBe(200);
  await closedForGood();
});

it("creates a new active code when the relay offer has none to reuse", async () => {
  const f = await fixture();
  await f.start();
  expect(f.app.context.services.devices.activePairing()).toBeNull();
  const offer = await f.offer();
  expect(offer.code).toMatch(/^\d{6}$/);
  expect(f.app.context.services.devices.activePairing()?.code).toBe(offer.code);
});

it("does not reuse an expired or exhausted pairing code", async () => {
  const f = await fixture();
  await f.start();
  const devices = f.app.context.services.devices;
  const now = Date.now();

  const expired = devices.startPairing(now - 10 * 60_000 - 1);
  expect(devices.activePairing(now)).toBeNull();
  const expiredOffer = await f.offer();
  expect(devices.activePairing()?.code).toBe(expiredOffer.code);
  expect(Date.parse(devices.activePairing()!.expires_at)).toBeGreaterThan(now);
  expect(Date.parse(devices.activePairing()!.expires_at)).toBeGreaterThan(Date.parse(expired.expires_at));

  const exhausted = devices.startPairing(now - 60_000);
  const wrong = exhausted.code === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 5; attempt += 1) expect(devices.pair(wrong, "Wrong", "drive")).toBeNull();
  expect(devices.activePairing()).toBeNull();
  const exhaustedOffer = await f.offer();
  expect(devices.activePairing()?.code).toBe(exhaustedOffer.code);
  expect(Date.parse(devices.activePairing()!.expires_at)).toBeGreaterThan(Date.parse(exhausted.expires_at));
});

it("starts, decodes an offer, pairs, authenticates, and carries full HTTP and WS through the relay", async () => {
  const f = await fixture();
  await f.start();
  expect(f.app.context.services.devices.gated).toBe(true);
  const offer = await f.offer();
  const paired = await client(f, offer);
  const response = await paired.http("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ auth: { via: "relay" }, relay: { phase: "online" } });
  await paired.ws();
  const returning = await client(f, offer, false, paired.device);
  expect((await returning.http("/api/relay")).status).toBe(200);
  expect(await (await returning.http("/api/access")).json()).toMatchObject({ relay: { phase: "online" } });
  for (const path of ["/api/relay/offer", "/api/relay/code", "/api/relay/code/cancel", "/api/relay/link/close", "/api/relay/reset-identity", "/api/relay/start", "/api/relay/stop"]) {
    const refused = await returning.http(path, { method: "POST", headers: [["x-herdr-update", "1"]] });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "local_required" } });
  }
});

it("hands a phone the PC's proven warm socket, so the PC opens none for it, and keeps the next one ready", async () => {
  const f = await fixture();
  await f.start();
  const warm = await bounded(f.warmOpened[0]!);
  // a keepalive sent after the proof is answered after the relay took that proof
  const proven = deferred<void>();
  warm.addEventListener("message", (event) => { if (event.data === '{"type":"pong"}') proven.resolve(); });
  warm.send('{"type":"ping"}');
  await bounded(proven.promise);
  const paired = await client(f, await f.offer());
  expect((await paired.http("/api/health")).status).toBe(200);
  expect(f.opened.filter((entry) => entry.kind === "data")).toEqual([]);
  expect(f.heard.some((message) => message.includes('"connected"'))).toBe(false);
  await bounded(f.warmOpened[1]!);
});

it("relay off closes sessions", async () => {
  const f = await fixture();
  await f.start();
  const peer = await client(f, await f.offer());
  const sockets = await Promise.all([peer.ws(), peer.ws()]);
  const controlClosed = deferred<void>();
  const closed = Room.prototype.closed;
  const observer = spyOn(Room.prototype, "closed").mockImplementation(function (this: Room<object>, socket) {
    // The only socket with no paired connection_id is the server control.
    if ("data" in socket && typeof socket.data === "object" && socket.data !== null
      && "info" in socket.data && typeof socket.data.info === "object" && socket.data.info !== null
      && "role" in socket.data.info && socket.data.info.role === "control") controlClosed.resolve();
    return closed.call(this, socket);
  });
  try {
    expect((await f.request("/stop", "POST")).status).toBe(200);
    expect(await bounded(peer.goaway)).toEqual({ code: "shutdown", last_open_id: Math.max(...sockets.map((socket) => socket.stream.id ?? 0)), drain_ms: 0 });
    expect(await bounded(Promise.all(sockets.map((socket) => socket.closed)))).toEqual([1001, 1001]);
    await bounded(controlClosed.promise);
    await bounded(peer.closed);
    expect(f.service.status()).toMatchObject({ phase: "off", sessions: 0 });
  } finally { observer.mockRestore(); }
});

it("revoke closes the session", async () => {
  const f = await fixture();
  await f.start();
  const peer = await client(f, await f.offer());
  const socket = await peer.ws();
  f.app.context.services.devices.revoke(peer.device.id);
  expect(await bounded(socket.closed)).toBe(1008);
  expect(await bounded(peer.error)).toBe("auth_revoked");
  await bounded(peer.closed);
});

it("resumes enabled state after restart", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  const before = await client(f, offer);
  await f.restart();
  const after = await client(f, offer, false, before.device);
  expect(await (await after.http("/api/relay")).json()).toMatchObject({ phase: "online" });
});

it("refuses relay on a serve-only installation", async () => {
  const previous = process.env["OVIS_TAILSCALE_SERVE_ONLY"];
  process.env["OVIS_TAILSCALE_SERVE_ONLY"] = "1";
  try {
    const f = await fixture();
    expect((await f.request("/start", "POST")).status).toBe(409);
    expect(f.service.status()).toMatchObject({ phase: "off", blocked: "serve_only" });
    expect(f.attempts).toBe(0);
  } finally {
    if (previous === undefined) delete process.env["OVIS_TAILSCALE_SERVE_ONLY"];
    else process.env["OVIS_TAILSCALE_SERVE_ONLY"] = previous;
  }
});

it("rejects CSRF before connecting or closing the device gate", async () => {
  const f = await fixture();
  expect((await f.request("/start", "POST", false)).status).toBe(403);
  const foreign = await fetch(f.base + "/api/relay/start", {
    method: "POST", headers: { "x-herdr-update": "1", origin: "https://foreign.invalid" },
  });
  expect(foreign.status).toBe(403);
  expect(f.attempts).toBe(0);
  expect(f.app.context.services.devices.gated).toBe(false);
});

it("rotates identity, closes old sessions, revokes only relay devices and reconnects", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  const peer = await client(f, offer);
  const store = f.app.context.services.devices;
  const direct = store.pair(store.startPairing().code, "Direct", "drive");
  expect(direct).not.toBeNull();
  expect((await f.request("/reset-identity", "POST")).status).toBe(200);
  await bounded(peer.closed);
  expect(store.has(peer.device.id)).toBe(false);
  expect(store.has(direct?.device.id ?? "")).toBe(true);
  const fresh = await f.offer();
  expect(fresh.server_id).not.toBe(offer.server_id);
  expect(fresh.server_public_key).not.toBe(offer.server_public_key);
  const replacement = await client(f, fresh);
  expect((await replacement.http("/api/relay")).status).toBe(200);
});

it.each(["ws://relay.example", "wss://user:secret@relay.example", "wss://relay.example/path", "wss://relay.example?a=b", "wss://a,b"])(
  "rejects malformed relay configuration %s", (relay) => {
    expect(() => new RelayService({ stateDir: tmpdir(), relay })).toThrow();
  },
);

it("fails closed on corrupt saved state and on an unreadable identity", async () => {
  const f = await fixture();
  loadRelayIdentity(f.stateDir);
  writeFileSync(join(f.stateDir, "relay", "state.json"), "{bad");
  await f.restart();
  // nothing goes through the relay: off, with the reason
  expect(f.service.status()).toMatchObject({ phase: "off", error: "Could not start the relay.", error_code: "start_failed" });
  expect(f.attempts).toBe(0);
  writeFileSync(relayIdentityPath(f.stateDir), "{bad");
  expect((await f.request("/start", "POST")).status).toBe(409);
  expect(f.service.status()).toMatchObject({ blocked: "identity_unreadable", error_code: "identity_unreadable" });
  expect(readFileSync(relayIdentityPath(f.stateDir), "utf8")).toBe("{bad");
  expect(f.attempts).toBe(0);
});

it("reads a start that failed before any link existed as off, with the reason, and a later start retries", async () => {
  const f = await fixture();
  loadRelayIdentity(f.stateDir);
  // the saved choice cannot be written: a directory stands where state.json goes
  const state = join(f.stateDir, "relay", "state.json");
  mkdirSync(state);
  const failed = await f.request("/start", "POST");
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ phase: "off", blocked: null, error: "Could not start the relay." });
  expect(f.service.linked).toBe(false);
  expect(f.attempts).toBe(0);
  rmSync(state, { recursive: true });
  const retried = await f.request("/start", "POST");
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ phase: "connecting", error: null });
});

it("cancels a connecting link before restart can resume it", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock });
  expect((await f.request("/start", "POST")).status).toBe(200);
  expect((await f.request("/stop", "POST")).status).toBe(200);
  const attempts = f.attempts;
  clock.advance(120_000);
  expect(f.attempts).toBe(attempts);
  await f.restart();
  expect(f.service.status().phase).toBe("off");
});

it("answers a repeated start with 200 while the link retries", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock });
  await f.start();
  const lost = f.controlLost;
  await f.localRelay.stop();
  await bounded(lost);
  expect(f.service.status().phase).toBe("error");
  const attempts = f.attempts;
  const again = await f.request("/start", "POST");
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ phase: "error" });
  expect(f.attempts).toBe(attempts);
});

it("keeps watch devices read-only on all relay mutations", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  const first = await client(f, offer);
  f.app.context.services.devices.update(first.device.id, { role: "watch" });
  await bounded(first.closed);
  const watch = await client(f, offer, false, first.device);
  expect((await watch.http("/api/relay")).status).toBe(200);
  for (const target of ["/api/relay/start", "/api/relay/stop", "/api/relay/offer", "/api/relay/reset-identity"]) {
    const response = await watch.http(target, { method: "POST", headers: [["x-herdr-update", "1"]] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
  }
});

it("keeps disabled offers unavailable and a disabled identity reset offline", async () => {
  const f = await fixture();
  expect((await f.request("/offer", "POST")).status).toBe(409);
  expect((await f.request("/reset-identity", "POST")).status).toBe(200);
  expect(f.service.status().phase).toBe("off");
  expect(f.attempts).toBe(0);
});

it("reconnects after repeated real relay restarts without replaying client requests", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock, random: () => 0.5 });
  await f.start();
  const offer = await f.offer();
  const peer = await client(f, offer);
  await peer.http("/api/relay");
  await f.interruptRelay(clock);
  await bounded(peer.closed);
  await f.interruptRelay(clock);
  const returning = await client(f, offer, false, peer.device);
  expect((await returning.http("/api/relay")).status).toBe(200);
});

it("bounds a client's incomplete protected handshake to fifteen seconds", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock, random: () => 0.5 });
  await f.start();
  const identity = loadRelayIdentity(f.stateDir);
  const raw = new WebSocket(`ws://127.0.0.1:${f.localRelay.port}/v1/ws?server_id=${identity.server_id}&role=client&v=1`);
  cleanup.push(() => raw.close());
  const closed = deferred<number>();
  raw.onclose = (event) => closed.resolve(event.code);
  const opened = deferred<void>();
  raw.onopen = () => opened.resolve();
  // with a warm socket the PC's side is ready before the client hears its socket opened
  await bounded(Promise.all([f.dataOpened, opened.promise]));
  clock.advance(14_999);
  expect(raw.readyState).toBe(WebSocket.OPEN);
  clock.advance(1);
  expect(await bounded(closed.promise)).toBe(1012);
  expect(f.service.status().sessions).toBe(0);
});

it.each(["http://app.example", "https://name:secret@app.example", "https://app.example/path", "https://app.example#fragment"])(
  "rejects malformed app configuration %s", (app) => {
    expect(() => new RelayService({ stateDir: tmpdir(), app })).toThrow();
  },
);

it("closes relay clients that never sign in, so they cannot hold the PC's slots", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock, random: () => 0.5 });
  await f.start();
  const offer = await f.offer();
  const squatters = [];
  // seven: the eighth would already push the oldest out (below)
  for (let index = 0; index < 7; index += 1) squatters.push(await squatter(f, offer));
  clock.advance(14_999);
  expect(squatters.every((squatting) => squatting.socket.readyState === WebSocket.OPEN)).toBe(true);
  const peer = client(f, offer);
  clock.advance(1);
  await bounded(Promise.all(squatters.map((squatting) => squatting.closed)));
  expect((await (await peer).http("/api/relay")).status).toBe(200);
  expect(f.service.status().sessions).toBe(1);
});

it("keeps at most four relay sessions per device, closing its oldest", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  // each session is used (a stream opened) before the next: only then does it count as the device's for good
  const first = await client(f, offer);
  expect((await first.http("/api/relay")).status).toBe(200);
  const later = [];
  for (let index = 0; index < 3; index += 1) {
    later.push(await client(f, offer, false, first.device));
    expect((await later.at(-1)!.http("/api/relay")).status).toBe(200);
  }
  expect(f.service.status().sessions).toBe(4);
  const fifth = await client(f, offer, false, first.device);
  expect((await fifth.http("/api/relay")).status).toBe(200);
  await bounded(first.closed);
  expect((await later[0]!.http("/api/relay")).status).toBe(200);
  expect(f.service.status().sessions).toBe(4);
});

it("refuses an offer while the relay is in error", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock, random: () => 0.5 });
  await f.start();
  const lost = f.controlLost;
  await f.localRelay.stop();
  await bounded(lost);
  expect(f.service.status().phase).toBe("error");
  const refused = await f.request("/offer", "POST");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "relay_offline" } });
});

it("keeps a signed-in client past the sign-in deadline", async () => {
  const clock = new TestClock();
  const f = await fixture(false, { clock, random: () => 0.5 });
  await f.start();
  const peer = await client(f, await f.offer());
  clock.advance(60_000);
  expect((await peer.http("/api/relay")).status).toBe(200);
  expect(f.service.status().sessions).toBe(1);
});

it("lets a new client in when every place holds a client that never signed in, evicting the oldest of them", async () => {
  // a frozen clock: no sign-in deadline fires, only the eviction can make room
  const f = await fixture(false, { clock: new TestClock() });
  await f.start();
  const offer = await f.offer();
  const squatters = [];
  for (let index = 0; index < 8; index += 1) squatters.push(await squatter(f, offer));
  // the eighth arrival pushes the oldest out at once (well before a squatter closes on its own, about 10 s in)
  await bounded(squatters[0]!.closed, 2_000);
  const peer = await client(f, offer);
  await bounded(squatters[1]!.closed, 2_000);
  expect((await peer.http("/api/relay")).status).toBe(200);
  expect(squatters.slice(2).every((squatting) => squatting.socket.readyState === WebSocket.OPEN)).toBe(true);
});

it("never evicts a signed-in session to make room", async () => {
  const f = await fixture(false, { clock: new TestClock() });
  await f.start();
  const first = await client(f, await f.offer());
  // each used before the next: used, a session counts as the device's for good; one never used could give way to a later racing carrier
  expect((await first.http("/api/relay")).status).toBe(200);
  const signedIn = [first];
  for (let index = 0; index < 3; index += 1) {
    signedIn.push(await client(f, await f.offer(), false, first.device));
    expect((await signedIn.at(-1)!.http("/api/relay")).status).toBe(200);
  }
  const squatters = [];
  for (let index = 0; index < 8; index += 1) squatters.push(await squatter(f, await f.offer()));
  const second = await client(f, await f.offer());
  for (const session of signedIn) expect((await session.http("/api/relay")).status).toBe(200);
  expect((await second.http("/api/relay")).status).toBe(200);
  expect(f.service.status().sessions).toBe(5);
});

/**
 * A PC between a global and a regional local relay with the given round trips. By default it names
 * no relay of its own and measures the regional one; `named` sets OVIS_RELAY_URL's value instead.
 */
async function regionalFixture({ rtt = { global: 130, regional: 13 } as { global: number | null; regional: number | null },
  stateDir = undefined as string | undefined, probeGate = undefined as Promise<void> | undefined, named = undefined as string | undefined } = {}) {
  const relays = { global: startBunRelay({ port: 0 }), regional: startBunRelay({ port: 0 }) };
  cleanup.push(() => relays.global.stop(), () => relays.regional.stop());
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "ovis-relay-region-"));
  if (!stateDir) cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const globalHost = named ? "relay.ovis.sh" : "global.test";
  const synced = { global: deferred<void>(), regional: deferred<void>() };
  const lost = { global: deferred<void>(), regional: deferred<void>() };
  const probed: string[] = [];
  const signals: AbortSignal[] = [];
  const service = new RelayService({
    stateDir: dir, ...(named ? { relay: named } : { relay: "wss://global.test", regionalRelays: ["wss://regional.test"] }),
    probe: async (relay, signal) => {
      probed.push(relay);
      signals.push(signal);
      await probeGate;
      return relay === `wss://${globalHost}` ? rtt.global : rtt.regional;
    },
    connect: (url) => {
      const target = new URL(url);
      const which = target.hostname === globalHost ? "global" : "regional";
      const socket = new WebSocket(`ws://127.0.0.1:${relays[which].port}${target.pathname}${target.search}`);
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced[which].resolve();
      });
      // the control socket: data and warm sockets come and go with phones
      if (!target.searchParams.has("connection_id") && !target.searchParams.has("warm")) socket.addEventListener("close", () => lost[which].resolve());
      return socket;
    },
  });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  return { dir, relays, synced, lost, probed, signals, service, post,
    async offer() { return decodeOffer(((await (await post("/offer")).json()) as { url: string }).url)!; },
    async link() { return decodeOffer(((await (await post("/link")).json()) as { url: string }).url)!; } };
}

it("advertises a regional relay that answers much faster, stays on the global one too, and keeps the choice", async () => {
  // Given a regional relay at a tenth of the global relay's round trip
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  // Then the PC is on both relays, and new offers name the regional one
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect(f.service.status()).toMatchObject({ phase: "online", relay: "wss://regional.test" });
  const offer = await f.offer();
  expect(offer.relay).toBe("wss://regional.test");
  // And a phone reaches it through either relay
  for (const port of [f.relays.regional.port, f.relays.global.port]) {
    const phone = await client({ localRelay: { port } } as Awaited<ReturnType<typeof fixture>>, { ...offer, code: (await f.offer()).code });
    expect((await phone.http("/api/health")).status).toBe(200);
    phone.close();
  }
  // And a restart keeps the choice without measuring again
  await f.service.shutdown();
  const again = await regionalFixture({ rtt: { global: null, regional: null }, stateDir: f.dir });
  expect((await again.post("/start")).status).toBe(200);
  await bounded(again.synced.regional.promise);
  expect(again.probed).toEqual([]);
  expect((await again.offer()).relay).toBe("wss://regional.test");
});

it("stays on the global relay alone when a regional one is not much faster or the global one does not answer", async () => {
  for (const rtt of [{ global: 100, regional: 60 }, { global: null, regional: 10 }]) {
    const f = await regionalFixture({ rtt });
    expect((await f.post("/start")).status).toBe(200);
    await bounded(f.synced.global.promise);
    expect([...f.probed].sort()).toEqual(["wss://global.test", "wss://regional.test"]);
    expect(f.service.status().relay).toBe("wss://global.test");
    expect((await f.offer()).relay).toBe("wss://global.test");
    expect(existsSync(join(f.dir, "relay", "region.json"))).toBe(false);
  }
});

it("keeps no measurement that finishes after the relay was turned off", async () => {
  // Given a measurement still running when the relay is turned off
  const gate = deferred<void>();
  const f = await regionalFixture({ probeGate: gate.promise });
  expect((await f.post("/start")).status).toBe(200);
  await bounded(f.synced.global.promise);
  expect((await f.post("/stop")).status).toBe(200);
  // Then its requests are cancelled
  expect(f.signals.length).toBe(2);
  expect(f.signals.every((signal) => signal.aborted)).toBe(true);
  // And when it finishes, nothing is saved and no regional link opens
  gate.resolve();
  // a macrotask runs only once every microtask the measurement queued has run
  await new Promise((resolve) => setImmediate(resolve));
  expect(existsSync(join(f.dir, "relay", "region.json"))).toBe(false);
  expect(f.service.status()).toMatchObject({ phase: "off", relay: "wss://global.test" });
});

it("names the relay new offers name in a pairing link without a code too", async () => {
  // Given a PC that chose a regional relay
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  // Then a link for comparing digits names the regional relay, as a QR code does
  expect((await f.link()).relay).toBe("wss://regional.test");
  // And the global relay while the regional link is down
  await f.relays.regional.stop();
  await bounded(f.lost.regional.promise);
  expect((await f.link()).relay).toBe("wss://global.test");
  // And a PC that chose no regional relay names the global one
  const plain = await regionalFixture({ rtt: { global: 100, regional: 60 } });
  expect((await plain.post("/start")).status).toBe(200);
  await bounded(plain.synced.global.promise);
  expect((await plain.link()).relay).toBe("wss://global.test");
});

it("names the global relay in new offers while the regional link is down, and reports the global link's state", async () => {
  // Given a PC on both relays
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  // When the regional relay goes away, offers name the global relay again, which stays online
  await f.relays.regional.stop();
  await bounded(f.lost.regional.promise);
  expect(f.service.status()).toMatchObject({ phase: "online", relay: "wss://global.test", error: null });
  expect((await f.offer()).relay).toBe("wss://global.test");
  // And when the global relay goes away too, the status says so
  await f.relays.global.stop();
  await bounded(f.lost.global.promise);
  expect(f.service.status().phase).toBe("error");
});

it("keeps a PC whose OVIS_RELAY_URL names a regional relay on the global relay too, without measuring", async () => {
  // Given OVIS_RELAY_URL naming Ovis's regional relay, which its phones fall back from
  const f = await regionalFixture({ named: "wss://relay-ap.ovis.sh" });
  expect((await f.post("/start")).status).toBe(200);
  // Then the PC is on both relays, measured nothing, and offers name the regional relay
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect(f.probed).toEqual([]);
  expect((await f.offer()).relay).toBe("wss://relay-ap.ovis.sh");
  expect(existsSync(join(f.dir, "relay", "region.json"))).toBe(false);
});

it("opens the regional link and keeps running when the choice cannot be saved", async () => {
  // Given a state folder where the choice cannot be written
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-region-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "relay", "region.json"), { recursive: true });
  const f = await regionalFixture({ stateDir: dir });
  expect((await f.post("/start")).status).toBe(200);
  // Then the PC is on both relays all the same, and offers name the regional one
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect((await f.offer()).relay).toBe("wss://regional.test");
});

/** A device typing `code`: one exchange on the rendezvous; the offer's JSON, the error it ended in, or the relay's close code. */
async function typeCode(f: Awaited<ReturnType<typeof fixture>>, code: string): Promise<{ offer?: string; error?: unknown; close?: number }> {
  const { nameplate } = splitPairCode(code);
  const socket = new WebSocket(`ws://127.0.0.1:${f.localRelay.port}/v1/pair?nameplate=${nameplate}&role=guest&v=1`);
  socket.binaryType = "arraybuffer";
  cleanup.push(() => socket.close());
  const guest = new PairCodeGuest(code);
  const done = deferred<{ offer?: string; error?: unknown; close?: number }>();
  let answered = false;
  socket.onmessage = (event) => {
    if (typeof event.data === "string") return;
    const frame = new Uint8Array(event.data as ArrayBuffer);
    try {
      if (!answered) { answered = true; socket.send(guest.answer(frame)); return; }
      done.resolve({ offer: guest.open(frame) });
    } catch (error) { done.resolve({ error }); }
  };
  socket.onclose = (event) => done.resolve({ close: event.code });
  return bounded(done.promise);
}

async function mintCode(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request("/code", "POST");
  expect(response.status).toBe(200);
  const body = await response.json() as { code: string; expires_at: string; server_id: string };
  expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  return body;
}

/** The same code with its last password character changed. */
const wrong = (code: string) => { const canonical = normalizePairCode(code)!; return canonical.slice(0, -1) + (canonical.endsWith("Z") ? "Y" : "Z"); };

it("a device that types the code gets the QR code's offer, pairs with its six-digit code, and the code is spent", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const minted = await mintCode(f);
  const devices = f.app.context.services.devices;
  expect(Date.parse(minted.expires_at)).toBe(Date.parse(devices.activePairing()!.expires_at));
  const typed = await typeCode(f, minted.code.toLowerCase());
  const offer = validateOffer(JSON.parse(typed.offer!));
  expect(offer.server_id).toBe(minted.server_id);
  expect(offer.code).toBe(devices.activePairing()!.code);
  const paired = await client(f, offer);
  expect((await paired.http("/api/health")).status).toBe(200);
  expect(await typeCode(f, minted.code)).toEqual({ close: PAIR_CLOSE.NO_HOST });
});

it("three wrong codes end it, deliver nothing, and never pause pairing with the QR code", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const minted = await mintCode(f);
  for (let index = 0; index < 3; index++) {
    // the PC heard a wrong confirmation and ended that try itself
    expect(await typeCode(f, wrong(minted.code))).toEqual({ close: PAIR_CLOSE.DROPPED });
  }
  expect(await typeCode(f, minted.code)).toEqual({ close: PAIR_CLOSE.NO_HOST });
  const devices = f.app.context.services.devices;
  expect(() => devices.assertRelayPairing()).not.toThrow();
  expect((await client(f, await f.offer())).device).toBeDefined();
});

it("a code whose six-digit code a phone spent with the QR code tells a device that knew it, and hands over no offer", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const minted = await mintCode(f);
  await client(f, await f.offer());
  const typed = await typeCode(f, minted.code);
  expect(typed.error).toBeInstanceOf(PairCodeExpiredError);
});

it("a new six-digit code takes the typed code off the relay", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const minted = await mintCode(f);
  f.app.context.services.devices.startPairing();
  expect(await typeCode(f, minted.code)).toEqual({ close: PAIR_CLOSE.NO_HOST });
});

it("a relay that is not Ovis's own has no codes to type", async () => {
  const f = await fixture();
  await f.start();
  const response = await f.request("/code", "POST");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "code_unavailable" } });
});

it("end to end: the hosted app's code screen finds the PC through the relay and the phone pairs with what it gets", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://relay.ovis.sh" });
  await f.start();
  const minted = await mintCode(f);
  const offer = await offerFromCode(minted.code, { connect: (url) => new WebSocket(url.replace("wss://relay.ovis.sh", `ws://127.0.0.1:${f.localRelay.port}`)) });
  expect(offer.server_id).toBe(minted.server_id);
  const paired = await client(f, offer);
  expect((await paired.http("/api/health")).status).toBe(200);
  expect(f.app.context.services.devices.list(null).some((device) => device.via_relay)).toBe(true);
});
