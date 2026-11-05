import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import { Room } from "../../relay/core.ts";
import { openClientSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { HttpRequest, SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import type { RelayStatus, ServerMessage } from "../../shared/protocol.ts";
import { createServer } from "../index.ts";
import { loadRelayIdentity, relayIdentityPath } from "./identity.ts";
import { RelayService } from "./service.ts";
import type { RelayServiceOptions } from "./service.ts";
import { bounded, deferred, TestClock } from "./test-helpers.ts";
import { relayClock } from "./session.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(serveOnly?: boolean, options: Partial<RelayServiceOptions> = {}) {
  let attempts = 0;
  const hostOptions = { port: 0, limiters: {
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
  const relayOptions = {
    stateDir, relay: `wss://127.0.0.1:${localRelay.port}`,
    connect: (url: string) => {
      const target = new URL(url);
      const socket = new WebSocket(`ws://127.0.0.1:${localRelay.port}${target.pathname}${target.search}`);
      if (target.searchParams.has("connection_id")) {
        socket.addEventListener("open", () => dataOpened.resolve(socket));
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

it("names the PC in the relay offer as Ovis lists it", async () => {
  const f = await fixture();
  await f.start();
  const offer = await f.offer();
  expect(offer.name).toBe(hostname().slice(0, 64));
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
  for (const path of ["/api/relay/offer", "/api/relay/reset-identity", "/api/relay/start", "/api/relay/stop"]) {
    const refused = await returning.http(path, { method: "POST", headers: [["x-herdr-update", "1"]] });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "local_required" } });
  }
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
  expect(f.service.status()).toMatchObject({ phase: "off", error: "Could not start the relay." });
  expect(f.attempts).toBe(0);
  writeFileSync(relayIdentityPath(f.stateDir), "{bad");
  expect((await f.request("/start", "POST")).status).toBe(409);
  expect(f.service.status().blocked).toBe("identity_unreadable");
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
  await bounded(f.dataOpened);
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
  const first = await client(f, offer);
  const later = [];
  for (let index = 0; index < 3; index += 1) later.push(await client(f, offer, false, first.device));
  expect(f.service.status().sessions).toBe(4);
  const fifth = await client(f, offer, false, first.device);
  await bounded(first.closed);
  expect((await fifth.http("/api/relay")).status).toBe(200);
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
  const signedIn = [first];
  for (let index = 0; index < 3; index += 1) signedIn.push(await client(f, await f.offer(), false, first.device));
  const squatters = [];
  for (let index = 0; index < 8; index += 1) squatters.push(await squatter(f, await f.offer()));
  const second = await client(f, await f.offer());
  for (const session of signedIn) expect((await session.http("/api/relay")).status).toBe(200);
  expect((await second.http("/api/relay")).status).toBe(200);
  expect(f.service.status().sessions).toBe(5);
});
