import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import { Room } from "../../relay/core.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey, openClientSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { decodeOffer, validateOffer } from "../../shared/relay-offer.ts";
import { normalizePairCode, PairCodeExpiredError, PairCodeGuest, splitPairCode } from "../../shared/relay-pair-code.ts";
import { PAIR_CLOSE } from "../../relay/pair-room.ts";
import { offerFromCode } from "../../src/lib/relay/pairCode.ts";
import { fetchMachines } from "../../src/lib/api.ts";
import { openRelayChannel } from "../../src/lib/relay/channel.ts";
import { openRelayTransport } from "../../src/lib/relay/transport.ts";
import { nativeTransport, setTransport } from "../../src/lib/transport.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
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
import { unitHerdrOnly } from "../../scripts/test-herdr.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../herdr/client.ts";
import { MachineCodeForAccountError } from "../machine-profile.ts";
import { ask, ended, linkRecord, pairingPc, sendLink, setUpFor, signedInWith, vouchFor, type Pc } from "../account/pairing.test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(serveOnly?: boolean, options: Partial<RelayServiceOptions> = {}, appOptions: NonNullable<Parameters<typeof createServer>[0]> = {}) {
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
  // The transport fixtures use the released Step 1 QR/code admission, not screen-confirmed Step 2 grants.
  const account = new FakeAccountService();
  const accountService = { url: "https://account.fixture.test", fetch: (request: Request) => account.fetch(request) };
  let app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, accountOpensAll: false,
    sidecar: false, tailscaleServeOnly: serveOnly, accountService, ...appOptions, relay: service });
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
    async request(path = "", method = "GET", guarded = true, headers: Record<string, string> = {}) {
      const guard: Record<string, string> = guarded ? { "x-herdr-update": "1" } : {};
      return this.local("/api/relay" + path, { method, headers: { ...guard, ...headers } });
    },
    /** A call from this PC itself. The machine profile's local owner is the caller on its socket in the state folder. */
    local(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
      if (appOptions.profile === "machine") return fetch("http://localhost" + path, { method: init.method, unix: join(stateDir, "serve.sock"), headers: { origin: "http://localhost", ...init.headers } });
      return fetch(this.base + path, { method: init.method, headers: { origin: this.base, ...init.headers } });
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
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, accountOpensAll: false, accountService, ...appOptions, relay: service });
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
    /** `body`: sent as the request's body, which `init.body` then says is a stream */
    async http(target: string, init: Partial<Omit<HttpRequest, "target" | "device_id">> = {}, body?: string) {
      const stream = engine.openHttp({ target, method: "GET", headers: [], body: "none", ...init });
      if (body !== undefined) void stream.sendBody(new Blob([body]).stream()).catch(() => {});
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
  const error = deferred<SessionError>();
  const frames: number[] = [];
  let mux: MuxEngine | undefined;
  const channel = await bounded(openClientSecureChannel(transport, { daemonPublicKeyB64: offer.server_public_key,
    events: { onmessage: (data) => {
      if (typeof data === "string") return;
      const frame = decodeFrame(new Uint8Array(data));
      frames.push(frame.type);
      if (frame.type === FrameType.SESSION_ERROR) error.resolve(frame.payload.code);
      mux?.receive(new Uint8Array(data));
    }, onclose: () => mux?.carrierLost() } }));
  mux = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
    onSession: (frame) => { if (frame.type === FrameType.WELCOME) welcome.resolve(); },
  });
  mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
  await bounded(welcome.promise);
  return { socket, mux, error: error.promise, frames, closed: closed.promise };
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

it("makes the relay tab's QR code only once an account was named for the PC, says in its state whether one is, and names it in the offer", async () => {
  const f = await fixture();
  await f.start();
  const devices = f.app.context.services.devices;
  const ask = (noAccountOnly: boolean) => fetch(`${f.base}/api/relay/offer`, { method: "POST",
    headers: { origin: f.base, "x-herdr-update": "1", ...(noAccountOnly ? { "x-ovis-no-account-only": "1" } : {}) } });
  const named = async () => (await (await f.request()).json() as RelayStatus).account_named;
  // a code another place shows as digits is pending
  const pending = devices.startPairing().code;
  let started = 0;
  devices.onPairingStarted(() => { started++; });
  expect(await named()).toBe(false);
  const refused = await ask(true);
  expect([refused.status, (await refused.json() as { error: { code: string } }).error.code]).toEqual([409, "no_account_named"]);
  // no code was started for it, and the one pending is as it was: an offer asked for without the header carries it
  expect([started, devices.activePairing()?.code]).toEqual([0, pending]);
  const plain = await ask(false);
  expect([plain.status, decodeOffer((await plain.json() as { url: string }).url)?.code, started]).toEqual([200, pending, 0]);
  // the owner names the account, as adding the PC on its own page or `ovis add` does
  const naming = await fetch(`${f.base}/api/account/relay-account`, { method: "POST",
    headers: { origin: f.base, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account: "acct_1" }) });
  expect(naming.status).toBe(204);
  expect(await named()).toBe(true);
  const offered = await ask(true);
  expect(offered.status).toBe(200);
  const answer = await offered.clone().json() as { account?: string | null };
  expect(answer.account).toBe("acct_1");
  // the QR code gets a code of its own, started for it
  expect([started, devices.activePairing()?.code]).toEqual([1, decodeOffer((await offered.json() as { url: string }).url)?.code]);
});

it("makes the relay tab's QR code only for a PC in no account, and takes it back when the PC joins one", async () => {
  const f = await fixture();
  await f.start();
  const devices = f.app.context.services.devices;
  // an account was named for the PC, as that QR code needs (the test above)
  expect(f.service.setRelayAccount("acct_1")).toBe(true);
  const ask = (noAccountOnly: boolean) => fetch(`${f.base}/api/relay/offer`, { method: "POST",
    headers: { origin: f.base, "x-herdr-update": "1", ...(noAccountOnly ? { "x-ovis-no-account-only": "1" } : {}) } });
  const codeOf = async (response: Response) => {
    expect(response.status).toBe(200);
    return decodeOffer((await response.json() as { url: string }).url)!.code;
  };
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const laptop = devices.pairRelay(devices.startPairing().code, "Laptop", key)!.device;
  // a code another place shows as digits is never the one the QR code carries
  devices.startPairing();
  let started = 0;
  devices.onPairingStarted(() => { started++; });
  const qr = await codeOf(await ask(true));
  expect([started, devices.activePairing()?.code]).toEqual([1, qr]);
  expect([await codeOf(await ask(true)), started]).toEqual([qr, 1]);
  // the page's other relay QR codes never carry it: their offer starts a code of its own, which replaces it
  const other = await codeOf(await ask(false));
  expect([started, devices.activePairing()?.code]).toEqual([2, other]);
  // and the QR code, asked for again, is given a code of its own once more
  const again = await codeOf(await ask(true));
  expect([started, devices.activePairing()?.code]).toEqual([3, again]);
  expect(devices.linkAccountKey(laptop.id, key, key, "acct_1")).not.toBeNull();
  // the PC is in an account: the code is taken back, and a page that still shows the QR code is refused a new one
  expect(devices.activePairing()).toBeNull();
  const refused = await ask(true);
  expect([refused.status, await refused.json()]).toEqual([409, { error: { code: "in_account", message: "This PC is already in an Ovis account. Sign in to that account on the device to add it." } }]);
  expect(devices.activePairing()).toBeNull();
  expect(await codeOf(await ask(false))).toMatch(/^\d{6}$/);
});

/**
 * A device that paired with the relay tab's QR code made for `account` and sent its link, vouched for by that account,
 * whose approval the account service is still reading: the read is held open until `release`. `judged` settles once
 * the link was judged on that approval (the link awaited the same answer first).
 */
async function linkHeldOnApproval(account: string) {
  let holding = false;
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await pairingPc({ accountFetch: async (request, service) => {
    if (holding && new URL(request.url).pathname === "/v1/pc/mailbox") { held.resolve(); await release.promise; }
    return service.fetch(request);
  } });
  cleanup.push(() => f.close());
  await setUpFor(f, account);
  const code = await f.tabCode();
  const pairing = f.devices.pairingId();
  const device = await signedInWith(f, code);
  await vouchFor(f, account, device.key);
  const mailbox = f.app.context.services.accountMailbox;
  const vouch = mailbox.vouch;
  const asked = Promise.withResolvers<{ answer: Promise<unknown> }>();
  mailbox.vouch = (...args) => { mailbox.vouch = vouch; const answer = vouch.apply(mailbox, args); asked.resolve({ answer }); return answer; };
  let revoked = false;
  f.devices.onRevoke(device.id, () => { revoked = true; });
  holding = true;
  void sendLink(device.session, await linkRecord(device.id, account, device.key)).catch(() => undefined);
  await held.promise;
  expect(f.devices.provisionalStands(device.id)).toBe(true);
  return { f, code, pairing, device, revoked: () => revoked, release: () => release.resolve(), judged: async () => { await (await asked.promise).answer; } };
}

/** Nothing of the link was written: the PC has no member, and nothing is on disk. */
async function noMember(f: Pc): Promise<void> {
  expect(await f.status()).toMatchObject({ account: null, members: 0 });
  expect(f.stored()).toEqual([]);
}

it("ends the relay tab's QR code, and the rows that wait to link under it, when another account is named for the PC", async () => {
  const { f, code, pairing, device, revoked, release, judged } = await linkHeldOnApproval("acct_a");
  // the same account named again (the add-me screen repeats it) changes nothing: the row's session stays open, and the
  // code still pairs
  await setUpFor(f, "acct_a");
  expect([f.devices.pairingId(), f.devices.provisionalStands(device.id), revoked()]).toEqual([pairing, true, false]);
  expect((await ask(device.session, "/api/account/status")).status).toBe(200);
  expect((await signedInWith(f, code)).role).toBe("watch");
  // a device that paired under the code made while acct_a was named is never taken into acct_b
  await setUpFor(f, "acct_b");
  expect([f.devices.activePairing(), f.devices.provisionalStands(device.id), revoked()]).toEqual([null, false, true]);
  // acct_a's approval, answered only now, writes no member, and the row's sessions end with its link
  release();
  await judged();
  await noMember(f);
  expect(await ended(device.session)).toBe("auth_revoked");
  // the QR code asked for again is a new one, for the account named now
  const again = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
  expect(again.body.account).toBe("acct_b");
  expect((again.body.pairing as { id: string }).id).not.toBe(pairing);
});

it("ends the code pending, and the rows that wait to link under it, when it resets the relay identity", async () => {
  const { f, device, revoked, release, judged } = await linkHeldOnApproval("acct_a");
  await f.app.context.services.relay.resetIdentity();
  expect([f.devices.activePairing(), f.devices.provisionalStands(device.id), revoked()]).toEqual([null, false, true]);
  // an approval asked under the old identity, answered only now, writes no member
  release();
  await judged();
  await noMember(f);
});

/** The saved account can no longer be read, as after a lost or damaged state file: the next naming reads as a first one. */
const loseSavedAccount = (f: Pc): void => { writeFileSync(join(f.stateDir, "relay", "account.json"), "{"); };

it("holds the relay tab's code to the account it was made under when another is named after the saved one could not be read", async () => {
  const f = await pairingPc();
  cleanup.push(() => f.close());
  await setUpFor(f, "acct_a");
  const code = await f.tabCode();
  const toB = await signedInWith(f, code), toA = await signedInWith(f, code);
  loseSavedAccount(f);
  await setUpFor(f, "acct_b");
  // the code and its rows are still there: what keeps them out of acct_b is the account the code was made under
  expect([f.devices.provisionalStands(toB.id), f.devices.provisionalStands(toA.id)]).toEqual([true, true]);
  await vouchFor(f, "acct_b", toB.key);
  const intoB = await sendLink(toB.session, await linkRecord(toB.id, "acct_b", toB.key));
  expect([intoB.status, intoB.body.error?.code]).toEqual([409, "account_mismatch"]);
  // nor is a row taken into acct_a while acct_b is named
  await vouchFor(f, "acct_a", toA.key);
  const intoA = await sendLink(toA.session, await linkRecord(toA.id, "acct_a", toA.key));
  expect([intoA.status, intoA.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect([f.devices.provisionalStands(toB.id), f.devices.provisionalStands(toA.id)]).toEqual([false, false]);
  await noMember(f);
});

it("takes no row of the relay tab's code into the account it was made under while the saved name cannot be read, before the approval", async () => {
  const f = await pairingPc();
  cleanup.push(() => f.close());
  await setUpFor(f, "acct_a");
  const device = await signedInWith(f, await f.tabCode());
  loseSavedAccount(f);
  await vouchFor(f, "acct_a", device.key);
  const refused = await sendLink(device.session, await linkRecord(device.id, "acct_a", device.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.provisionalStands(device.id)).toBe(false);
  await noMember(f);
});

it("takes no row of the relay tab's code into the account it was made under when the saved name cannot be read by the time the approval comes", async () => {
  const { f, device, release, judged } = await linkHeldOnApproval("acct_a");
  loseSavedAccount(f);
  release();
  await judged();
  await noMember(f);
  expect(f.devices.provisionalStands(device.id)).toBe(false);
});

it("refuses after the approval too when another is named, past a saved account that could not be read, while the approval is out", async () => {
  const { f, device, release, judged } = await linkHeldOnApproval("acct_a");
  loseSavedAccount(f);
  await setUpFor(f, "acct_b");
  expect(f.devices.provisionalStands(device.id)).toBe(true);
  release();
  await judged();
  await noMember(f);
  expect(f.devices.provisionalStands(device.id)).toBe(false);
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
  const closed = await f.request("/link/close", "POST");
  expect(closed.status).toBe(200);
  expect(await closed.json()).toEqual({ ok: true });
  expect(f.service.approvals.windowOpen()).toBe(false);
  // Then a restart does not bring it back
  await f.restart();
  expect(f.service.approvals.windowOpen()).toBe(false);
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

it("a bound PC with an unreadable registry refuses identity reset before closing its relay or changing its binding", async () => {
  const f = await fixture(false, {}, { accountOpensAll: true });
  await f.start();
  f.app.context.services.devices.bindByService("acct_fixture");
  const binding = () => readFileSync(join(f.stateDir, "account-pc.json"), "utf8");
  const identity = () => readFileSync(relayIdentityPath(f.stateDir), "utf8");
  const before = [binding(), identity()];
  const registry = join(f.stateDir, "devices.json");
  writeFileSync(registry, "not JSON", { mode: 0o600 });
  await f.restart();
  expect(f.app.context.services.devices.error).not.toBeNull();
  const priorPhase = f.service.status().phase;
  const response = await f.request("/reset-identity", "POST");
  expect([response.status, (await response.json()).error?.code, f.service.status().phase, binding() === before[0],
    identity() === before[1], readFileSync(registry, "utf8") === "not JSON"]).toEqual([503, "gate_unavailable", priorPhase, true, true, true]);
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
      if (!target.searchParams.has("connection_id") && !target.searchParams.has("warm")) socket.addEventListener("close", () => lost[which].resolve());
      return socket;
    },
  });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, relay: service, accountOpensAll: false });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  return { dir, relays, synced, lost, probed, signals, service, post,
    async offer() { return decodeOffer(((await (await post("/offer")).json()) as { url: string }).url)!; },
    async link() { return decodeOffer(((await (await post("/link")).json()) as { url: string }).url)!; } };
}

it("advertises a regional relay that answers much faster, stays on the global one too, and keeps the choice", async () => {
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect(f.service.status()).toMatchObject({ phase: "online", relay: "wss://regional.test" });
  const offer = await f.offer();
  expect(offer.relay).toBe("wss://regional.test");
  for (const port of [f.relays.regional.port, f.relays.global.port]) {
    const phone = await client({ localRelay: { port } } as Awaited<ReturnType<typeof fixture>>, { ...offer, code: (await f.offer()).code });
    expect((await phone.http("/api/health")).status).toBe(200);
    phone.close();
  }
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
  const gate = deferred<void>();
  const f = await regionalFixture({ probeGate: gate.promise });
  expect((await f.post("/start")).status).toBe(200);
  await bounded(f.synced.global.promise);
  expect((await f.post("/stop")).status).toBe(200);
  expect(f.signals.length).toBe(2);
  expect(f.signals.every((signal) => signal.aborted)).toBe(true);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(existsSync(join(f.dir, "relay", "region.json"))).toBe(false);
  expect(f.service.status()).toMatchObject({ phase: "off", relay: "wss://global.test" });
});

it("names the relay new offers name in a pairing link without a code too", async () => {
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect((await f.link()).relay).toBe("wss://regional.test");
  await f.relays.regional.stop();
  await bounded(f.lost.regional.promise);
  expect((await f.link()).relay).toBe("wss://global.test");
  const plain = await regionalFixture({ rtt: { global: 100, regional: 60 } });
  expect((await plain.post("/start")).status).toBe(200);
  await bounded(plain.synced.global.promise);
  expect((await plain.link()).relay).toBe("wss://global.test");
});

it("names the global relay in new offers while the regional link is down, and reports the global link's state", async () => {
  const f = await regionalFixture();
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  await f.relays.regional.stop();
  await bounded(f.lost.regional.promise);
  expect(f.service.status()).toMatchObject({ phase: "online", relay: "wss://global.test", error: null });
  expect((await f.offer()).relay).toBe("wss://global.test");
  await f.relays.global.stop();
  await bounded(f.lost.global.promise);
  expect(f.service.status().phase).toBe("error");
});

it("keeps a PC whose OVIS_RELAY_URL names a regional relay on the global relay too, without measuring", async () => {
  const f = await regionalFixture({ named: "wss://relay-ap.ovis.sh" });
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect(f.probed).toEqual([]);
  expect((await f.offer()).relay).toBe("wss://relay-ap.ovis.sh");
  expect(existsSync(join(f.dir, "relay", "region.json"))).toBe(false);
});

it("opens the regional link and keeps running when the choice cannot be saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-region-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "relay", "region.json"), { recursive: true });
  const f = await regionalFixture({ stateDir: dir });
  expect((await f.post("/start")).status).toBe(200);
  await bounded(Promise.all([f.synced.global.promise, f.synced.regional.promise]));
  expect((await f.offer()).relay).toBe("wss://regional.test");
});

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

it("a typed code made for an account: its answer names the account and the code, the offer for that account carries the same code, and the device that types it waits to link", async () => {
  const f = await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const ask = (path: string, account?: string) => fetch(`${f.base}/api/relay${path}`, { method: "POST", headers: { origin: f.base, "x-herdr-update": "1", ...(account ? { "x-ovis-expect-account": account } : {}) } });
  // without the header the answer is what it always was, and names its code by its id
  expect(Object.keys(await mintCode(f)).sort()).toEqual(["code", "expires_at", "pairing", "server_id"]);
  const minted = await (await ask("/code", "acct_owner")).json() as { code: string; expect_account: string; pairing: { id: string } };
  expect(minted.expect_account).toBe("acct_owner");
  const devices = f.app.context.services.devices;
  const offered = await (await ask("/offer", "acct_owner")).json() as { url: string; expect_account: string; pairing: { id: string } };
  expect([decodeOffer(offered.url)?.code, offered.pairing.id]).toEqual([devices.activePairing()!.code, minted.pairing.id]);
  const typed = validateOffer(JSON.parse((await typeCode(f, minted.code)).offer!));
  expect(typed.code).toBe(devices.activePairing()!.code);
  // the offer the typed code delivers carries the mark, as the QR code's does
  expect([typed.admission, decodeOffer(offered.url)?.admission]).toEqual([1, 1]);
  const paired = await client(f, typed);
  expect(devices.list(null)).toEqual([]);
  expect((await paired.http("/api/health")).status).toBe(403);
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

async function machineFixture(appOptions: NonNullable<Parameters<typeof createServer>[0]> = {}, relayOptions: Partial<RelayServiceOptions> = {}) {
  const account = new FakeAccountService();
  const options = { profile: "machine" as const, accountService: { url: "https://account.test", fetch: account.fetch }, ...appOptions };
  const f = await fixture(false, { accountService: "https://account.test", accountFetch: account.fetch, ...relayOptions }, options);
  return Object.assign(f, {
    account,
    async offer(): Promise<RelayOffer> {
      const identity = loadRelayIdentity(f.stateDir);
      return { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: `wss://127.0.0.1:${f.localRelay.port}`,
        code: f.app.context.services.devices.startPairing().code };
    },
  });
}

const errorCode = async (response: Response) => (await response.json() as { error?: { code: string } }).error?.code;

it.each(["an ordinary server", "the machine profile"])("pairing codes on %s in no account: a machine makes one only for an account, an ordinary server as today", async (kind) => {
  const machine = kind === "the machine profile";
  const f = machine ? await machineFixture({}, { pairCodeRelay: "wss://pair.test" }) : await fixture(false, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const devices = f.app.context.services.devices;
  const peer = await client(f, await f.offer());
  const pending = devices.startPairing().code;
  let started = 0;
  devices.onPairingStarted(() => { started++; });
  const plain = { "x-ovis-no-account-only": "1" };
  const answers: [string, number, string | undefined][] = [];
  for (const [path, headers] of [["/offer", {}], ["/offer", plain], ["/code", {}], ["/code", plain]] as const) {
    const response = await f.request(path, "POST", true, headers);
    answers.push([`${path} ${JSON.stringify(headers)}`, response.status, await errorCode(response)]);
  }
  const local = await f.local("/api/devices/pair/start", { method: "POST", headers: { "x-herdr-machine": "1" } });
  answers.push(["pair/start on this PC", local.status, await errorCode(local)]);
  const relayed = await peer.http("/api/devices/pair/start", { method: "POST", headers: [["x-herdr-machine", "1"]] });
  answers.push(["pair/start through the relay", relayed.status, await errorCode(relayed)]);
  if (machine) {
    expect(answers).toEqual(answers.map(([call]) => [call, 409, "machine_profile"]));
    // nothing was made, and the code pending stays as it was
    expect([started, devices.activePairing()?.code]).toEqual([0, pending]);
  } else {
    expect(answers).toEqual([['/offer {}', 200, undefined], ['/offer {"x-ovis-no-account-only":"1"}', 409, "no_account_named"], ['/code {}', 200, undefined],
      ['/code {"x-ovis-no-account-only":"1"}', 200, undefined], ["pair/start on this PC", 200, undefined], ["pair/start through the relay", 200, undefined]]);
  }
  // a code for an account is made as on any PC
  for (const path of ["/offer", "/code"]) {
    const named = await f.request(path, "POST", true, { "x-ovis-expect-account": "acct_owner" });
    expect([path, named.status, (await named.json() as { expect_account?: string }).expect_account]).toEqual([path, 200, "acct_owner"]);
  }
});

it("machine profile refuses a code for no account while its relay reconnects, and the code pending for an account stays", async () => {
  const clock = new TestClock();
  const f = await machineFixture({}, { clock, random: () => 0.5, pairCodeRelay: "wss://pair.test" });
  await f.start();
  const devices = f.app.context.services.devices;
  const named = await f.request("/offer", "POST", true, { "x-ovis-expect-account": "acct_owner" });
  expect(named.status).toBe(200);
  const pending = decodeOffer((await named.json() as { url: string }).url)!.code;
  expect(devices.activePairing()?.code).toBe(pending);
  const lost = f.controlLost;
  await f.localRelay.stop();
  await bounded(lost);
  expect(f.service.status().phase).toBe("error");
  // the answer is the profile's, whatever the relay's state: the command line takes nothing back after it
  const answers: [string, number, string | undefined][] = [];
  for (const path of ["/code", "/offer"]) {
    const response = await f.request(path, "POST");
    answers.push([path, response.status, await errorCode(response)]);
  }
  expect(answers).toEqual([["/code", 409, "machine_profile"], ["/offer", 409, "machine_profile"]]);
  expect(devices.activePairing()?.code).toBe(pending);
});

it("machine profile: the relay service itself makes no code and no offer for no account, whoever calls it", async () => {
  const f = await machineFixture({}, { pairCodeRelay: "wss://pair.test" });
  await f.start();
  const devices = f.app.context.services.devices;
  const pending = devices.startPairing().code;
  let started = 0;
  devices.onPairingStarted(() => { started++; });
  expect(() => f.service.offer()).toThrow(MachineCodeForAccountError);
  expect(() => f.service.offer(null, { noAccountOnly: true })).toThrow(MachineCodeForAccountError);
  await expect(f.service.pairCode()).rejects.toBeInstanceOf(MachineCodeForAccountError);
  expect([started, devices.activePairing()?.code]).toEqual([0, pending]);
});

it("machine profile takes a device in with a code made for its account: the device links itself into that account", async () => {
  const f = await machineFixture();
  await f.start();
  const devices = f.app.context.services.devices;
  // the call `ovis add` makes on the machine's socket
  const made = await f.request("/offer", "POST", true, { "x-ovis-expect-account": "acct_owner" });
  expect(made.status).toBe(200);
  const offer = decodeOffer((await made.json() as { url: string }).url)!;
  const paired = await client(f, offer);
  expect(devices.list(null)).toEqual([]);
  const session = await client(f, offer, false, paired.device);
  const key = Buffer.from(await crypto.subtle.exportKey("spki", paired.device.keys.publicKey)).toString("base64url");
  // the device's account vouches for its key first, as an app does for an offer with the mark
  expect(offer.admission).toBe(1);
  const token = f.account.issueToken("acct_owner");
  const accountCall = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await accountCall(`/v1/pcs/${offer.server_id}`, "PUT", { label: "Machine", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: "wss://relay.ovis.sh" })).status).toBe(200);
  expect((await accountCall("/v1/admissions", "POST", { server_id: offer.server_id, label: "Phone", key })).status).toBe(200);
  const record = await signAccountRecord({ v: 1, kind: "link", account: "acct_owner", key, server_id: offer.server_id, device_id: paired.device.id,
    old_key: key, issued_at: new Date().toISOString(), id: newRecordId(), signer: key }, paired.device.keys.privateKey);
  const linked = await session.http("/api/account/link", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" },
    JSON.stringify({ record }));
  expect(linked.status).toBe(200);
  expect(devices.account()).toBe("acct_owner");
  expect(devices.list(null).map((device) => device.id)).toEqual([paired.device.id]);
});

it.each(["missing HTTP", "missing WS", "wrong"])("machine profile refuses %s proof over the real relay", async (scenario) => {
  const f = await machineFixture();
  await f.start();
  const offer = await f.offer();
  const allowed = await client(f, offer);
  const peer = await squatter(f, offer);
  if (scenario === "wrong") peer.mux.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0,
    payload: { scheme: "device-key", device_id: allowed.device.id, signature: Buffer.alloc(64, 9).toString("base64url") } });
  else {
    // The malicious client claims local admission so it can send OPEN; the server has granted none.
    peer.mux.authenticate(allowed.device.id);
    if (scenario.endsWith("HTTP")) peer.mux.openHttp({ target: "/api/session", method: "GET", headers: [], body: "none" });
    else peer.mux.openWs({ target: "/ws", protocols: [], headers: [] });
  }
  expect(await bounded(peer.error)).toBe(scenario === "wrong" ? "auth_failed" : "protocol_error");
  await bounded(peer.closed);
  expect(peer.frames.filter((type) => [FrameType.AUTH_OK, FrameType.HTTP_HEADERS, FrameType.WS_ACCEPT, FrameType.WS_DATA].some((forbidden) => forbidden === type))).toEqual([]);
  expect(await (await allowed.http("/api/health")).json()).toMatchObject({ machine_profile: { engine: "herdr" } });
});

it.each(["HTTP", "WS", "the PC list"])("machine profile filters secret-bearing snapshots over %s even when bridge-only was requested", async (surface) => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-machine-secret-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config.toml");
  writeFileSync(config, '[ui.sidebar.agents]\nrows = [["agent", { token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]\n');
  const workspace = await workspaceCreate({ cwd: dir, label: "machine-secret" });
  cleanup.push(() => workspaceClose(workspace.workspace.workspace_id));
  const paneId = workspace.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
  await herdrRpc("pane.report_metadata", { pane_id: paneId, source: "plugin:quota", tokens: { quota: "off machine-secret", eta: "soon" } });
  const f = await machineFixture({ herdrConfigPath: config, bridgeOnly: true });
  await f.start();
  const peer = await client(f, await f.offer());
  let snapshot: unknown;
  if (surface === "HTTP") snapshot = await (await peer.http("/api/session")).json();
  else if (surface === "the PC list") snapshot = (await (await peer.http("/api/machines")).json() as { machines: { snapshot: unknown }[] }).machines[0]?.snapshot;
  else {
    const received = deferred<unknown>();
    const stream = peer.mux.openWs({ target: "/ws", protocols: [], headers: [] });
    stream.onMessage = (data) => {
      const message: ServerMessage = JSON.parse(String(data));
      if (message.type === "snapshot") received.resolve(message.snapshot);
    };
    snapshot = await bounded(received.promise);
  }
  expect(JSON.stringify(snapshot)).toContain(paneId);
  expect(JSON.stringify(snapshot)).toContain('"eta":"soon"');
  expect(JSON.stringify(snapshot)).not.toContain("off machine-secret");
});

it("machine profile reuses its key, saved state and paired device across a restart", async () => {
  const f = await machineFixture();
  await f.start();
  const offer = await f.offer();
  const peer = await client(f, offer);
  const identity = readFileSync(relayIdentityPath(f.stateDir), "utf8");
  const state = readFileSync(join(f.stateDir, "relay", "state.json"), "utf8");
  await f.restart();
  const returning = await client(f, offer, false, peer.device);
  expect(readFileSync(relayIdentityPath(f.stateDir), "utf8")).toBe(identity);
  expect(readFileSync(join(f.stateDir, "relay", "state.json"), "utf8")).toBe(state);
  expect(await (await returning.http("/api/health")).json()).toMatchObject({ ok: true, machine_profile: { engine: "herdr" } });
});

it("machine profile opens no direct listener even when the relay service is given one", async () => {
  let bound = 0;
  const f = await machineFixture({ token: "owner-token" }, { direct: { addresses: () => { bound++; return ["127.0.0.1"]; }, peerAllowed: () => true, preferredPort: 0 } });
  f.service.start();
  expect(f.service.directAvailable).toBe(false);
  expect(bound).toBe(0);
});

class MemoryStore implements RelayDeviceStore {
  saved: RelayDevice | undefined;
  async get() { return this.saved; }
  async update(_id: string, change: (current: RelayDevice | undefined) => RelayDevice) { return (this.saved = change(this.saved)); }
  async list() { return this.saved ? [this.saved] : []; }
  async remove() { this.saved = undefined; }
}

it("machine profile lists itself alone, with its terminals, to the app reading its PCs through the relay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-machine-list-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const made = await workspaceCreate({ cwd: dir, label: "machine-list" });
  cleanup.push(() => workspaceClose(made.workspace.workspace_id));
  const f = await machineFixture();
  await f.start();
  const offer = await f.offer();
  const transport = await openRelayTransport(offer, { store: new MemoryStore(), openChannel: (opened, options) => openRelayChannel(opened, { ...options,
    socket: (url) => { const target = new URL(url); return new WebSocket(`ws://127.0.0.1:${f.localRelay.port}${target.pathname}${target.search}`); } }) });
  cleanup.push(() => { setTransport(nativeTransport); transport.close(); });
  setTransport(transport);
  const machines = await fetchMachines();
  expect(machines.map(({ id, name, kind, state, error, server_id }) => ({ id, name, kind, state, error, server_id })))
    .toEqual([{ id: "local", name: hostname(), kind: "local", state: "connected", error: null, server_id: offer.server_id }]);
  expect(machines[0]!.snapshot?.workspaces.map((workspace) => workspace.workspace_id)).toContain(made.workspace.workspace_id);
  expect(machines[0]!.snapshot?.panes.map((pane) => pane.pane_id)).toContain(made.root_pane.pane_id);
});

it("machine profile refuses its closed controls to a device through the relay with its proof", async () => {
  const f = await machineFixture();
  await f.start();
  const peer = await client(f, await f.offer());
  for (const target of ["/api/herdr/update", "/api/runtime/move", "/api/portal/start", "/api/machines", "/api/fleet/enable", "/api/bridge"]) {
    const response = await peer.http(target, { method: "POST", headers: [["x-herdr-update", "1"]] });
    expect([target, response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([target, 409, "machine_profile"]);
  }
});

it.each(["an ordinary server", "the machine profile"])("%s refuses pane input to a watch device through the relay", async (kind) => {
  const f = kind === "the machine profile" ? await machineFixture() : await fixture();
  await f.start();
  const offer = await f.offer();
  const first = await client(f, offer);
  f.app.context.services.devices.update(first.device.id, { role: "watch" });
  await bounded(first.closed);
  const watch = await client(f, offer, false, first.device);
  const response = await watch.http("/api/pane/input", { method: "POST", headers: [["x-herdr-update", "1"]] });
  expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
});

it("machine profile gives a plugin run's state to a device that drives it and refuses a watch device", async () => {
  const f = await machineFixture();
  await f.start();
  const offer = await f.offer();
  const drive = await client(f, offer);
  // a driving device reaches the route (it asks for a run with no log id, which the route itself refuses)
  const driving = await drive.http("/api/plugin/action");
  expect([driving.status, (await driving.json() as { error: { code: string } }).error.code]).not.toEqual([403, "read_only"]);
  f.app.context.services.devices.update(drive.device.id, { role: "watch" });
  await bounded(drive.closed);
  const watch = await client(f, offer, false, drive.device);
  const watching = await watch.http("/api/plugin/action?log_id=x");
  expect([watching.status, (await watching.json() as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
});

it("machine profile tells a paired relay device why its classic engine is absent", async () => {
  const restore = unitHerdrOnly();
  cleanup.push(restore);
  const f = await machineFixture();
  await f.start();
  const peer = await client(f, await f.offer());
  const response = await peer.http("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, auth: { authenticated: true, via: "relay" },
    machine_profile: { engine: "herdr", runtime_down: true, reason: "herdr is not running for the selected session" } });
});
