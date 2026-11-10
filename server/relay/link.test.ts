import { afterEach, expect, it } from "bun:test";
import { loadRelayIdentity } from "./identity.ts";
import { RelayLink } from "./link.ts";
import type { RelayLinkOptions } from "./link.ts";
import { bounded, deferred, relayFixture, relayPhone, TestClock } from "./test-helpers.ts";
import { serverChallenge, SERVER_PROOF_CLOSE, SERVER_PROOF_REQUIRED } from "../../shared/relay-server-proof.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { signRelayPass } from "../../shared/relay-pass.ts";

const fixtures: ReturnType<typeof relayFixture>[] = [];
/** links and relays a test left running, stopped before its fixture goes */
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

for (const refusal of [
  { reason: "server proof timed out", code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: "invalid or expired server proof", code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: SERVER_PROOF_REQUIRED, code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: "too many server proofs pending", code: 1013, permanent: false },
  { reason: "server key does not match server_id", code: SERVER_PROOF_CLOSE, permanent: true },
  { reason: "invalid server key", code: SERVER_PROOF_CLOSE, permanent: true },
  { reason: "protocol order", code: 4000, permanent: false },
]) {
  it(`${refusal.permanent ? "stops and reports" : "retries"} after ${refusal.reason} on the control socket`, async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const clock = new TestClock();
    const failed = deferred<{ error: string; code: string | undefined }>();
    const states: string[] = [];
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        open(socket) {
          if (refusal.code === 4000) socket.send('{"type":"sync","connection_ids":[]}');
          else socket.close(refusal.code, refusal.reason);
        },
        message() {},
      },
    });
    const link = new RelayLink({
      relay: `ws://127.0.0.1:${server.port}`, identity: loadRelayIdentity(fixture.stateDir),
      services: fixture.app.context.services, port: fixture.app.port, clock, random: () => 0.5,
      connect: (url) => { attempts++; return new WebSocket(url); },
      onState: (phase, error, code) => {
        states.push(phase);
        if (phase === "error" && error) failed.resolve({ error, code });
      },
    });
    try {
      link.start();
      const { error, code } = await bounded(failed.promise);
      expect(code).toBe(refusal.permanent ? "server_key_refused" : "relay_unreachable");
      if (refusal.permanent) {
        expect(error).toContain(String(SERVER_PROOF_CLOSE));
        clock.advance(60_000);
        expect(attempts).toBe(1);
        expect(clock.tasks.size).toBe(0);
      } else {
        clock.advance(999);
        expect(attempts).toBe(1);
        clock.advance(1);
        expect(attempts).toBe(2);
        expect(states.at(-1)).toBe("connecting");
      }
    } finally {
      await link.stop();
      await server.stop(true);
    }
  });
}

it("reconnects linearly from one to thirty seconds with twenty percent jitter and cancels on stop", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const attempts: number[] = [];
  let random = 0;
  const link = new RelayLink({
    relay: "wss://relay.example", identity: loadRelayIdentity(fixture.stateDir),
    services: fixture.app.context.services, port: fixture.app.port, clock, random: () => random,
    connect: () => { attempts.push(clock.now()); throw new Error("Network unavailable"); },
    onState: () => {},
  });
  link.start();
  expect(attempts).toEqual([0]);
  for (let attempt = 1; attempt <= 35; attempt++) {
    const delay = Math.min(attempt, 30) * 1000 * (random === 0 ? 0.8 : 1.2);
    clock.advance(delay - 1);
    expect(attempts).toHaveLength(attempt);
    random = random === 0 ? 1 : 0;
    clock.advance(1);
    expect(attempts).toHaveLength(attempt + 1);
  }
  await link.stop();
  clock.advance(60_000);
  expect(attempts).toHaveLength(36);
  expect(clock.tasks.size).toBe(0);
});

for (const warm of [false, true]) {
  it(`opens a warm socket only when the relay's sync says it takes one (${warm ? "it does" : "an older relay"})`, async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const identity = loadRelayIdentity(fixture.stateDir);
    const online = deferred<void>();
    const urls: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        open(socket) {
          socket.send(serverChallenge(importPublicKey(identity.public_key), { server_id: identity.server_id, role: "control", connection_id: null }).frame);
        },
        message(socket) { socket.send(JSON.stringify({ type: "sync", connection_ids: [], ...(warm ? { warm: "ab".repeat(16) } : {}) })); },
      },
    });
    const link = new RelayLink({
      relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
      clock: new TestClock(), random: () => 0.5, connect: (url) => { urls.push(url); return new WebSocket(url); },
      onState: (phase) => { if (phase === "online") online.resolve(); },
    });
    try {
      link.start();
      await bounded(online.promise);
      // the warm socket, if any, is opened in the same turn that read the sync
      expect(urls.map((url) => new URL(url).searchParams.get("warm"))).toEqual(warm ? [null, "ab".repeat(16)] : [null]);
    } finally {
      await link.stop();
      await server.stop(true);
    }
  });
}

it("tries a warm socket again after a pause when opening one throws", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const identity = loadRelayIdentity(fixture.stateDir);
  const online = deferred<void>();
  const attempts: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      open(socket) {
        socket.send(serverChallenge(importPublicKey(identity.public_key), { server_id: identity.server_id, role: "control", connection_id: null }).frame);
      },
      message(socket) { socket.send(JSON.stringify({ type: "sync", connection_ids: [], warm: "ab".repeat(16) })); },
    },
  });
  const link = new RelayLink({
    relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
    clock, random: () => 0.5, onState: (phase) => { if (phase === "online") online.resolve(); },
    connect: (url) => {
      const warm = new URL(url).searchParams.get("warm");
      attempts.push(warm);
      if (warm && attempts.filter(Boolean).length === 1) throw new Error("Network unavailable");
      return new WebSocket(url);
    },
  });
  try {
    link.start();
    await bounded(online.promise);
    expect(attempts).toEqual([null, "ab".repeat(16)]);
    clock.advance(999);
    expect(attempts).toHaveLength(2);
    clock.advance(1);
    expect(attempts).toEqual([null, "ab".repeat(16), "ab".repeat(16)]);
  } finally {
    await link.stop();
    await server.stop(true);
  }
});

it("gives up on a warm socket the relay stopped answering and opens another, without waiting for its close", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const identity = loadRelayIdentity(fixture.stateDir);
  const generation = "ab".repeat(16);
  const opened: { url: URL; socket: WebSocket }[] = [];
  const warmOpened = [deferred<void>(), deferred<void>()];
  let pong = deferred<void>();
  const server = Bun.serve<{ warm: boolean }>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: { warm: new URL(request.url).searchParams.has("warm") } }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(serverChallenge(importPublicKey(identity.public_key), { server_id: identity.server_id,
          role: socket.data.warm ? "warm" : "control", connection_id: socket.data.warm ? generation : null }).frame);
      },
      // the control socket is answered; the warm socket, once it has sent its proof, never again
      message(socket, message) {
        if (socket.data.warm) return;
        if (message === '{"type":"ping"}') socket.send('{"type":"pong"}');
        else socket.send(JSON.stringify({ type: "sync", connection_ids: [], warm: generation }));
      },
    },
  });
  const link = new RelayLink({
    relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
    clock, random: () => 0.5, onState: () => {},
    connect: (address) => {
      const url = new URL(address);
      const socket = new WebSocket(address);
      opened.push({ url, socket });
      const warm = opened.filter((entry) => entry.url.searchParams.has("warm")).length;
      if (url.searchParams.has("warm")) {
        // proven: the relay's challenge, the last thing it says on this socket, has arrived
        const send = socket.send.bind(socket);
        socket.send = (data) => { send(data); if (typeof data === "string" && data.includes('"server_proof"')) warmOpened[warm - 1]?.resolve(); };
      } else socket.addEventListener("message", (event) => { if (event.data === '{"type":"pong"}') pong.resolve(); });
      return socket;
    },
  });
  try {
    link.start();
    await bounded(warmOpened[0]!.promise);
    // the control socket stays answered every ten seconds; the warm one goes silent
    for (let step = 0; step < 2; step++) {
      pong = deferred<void>();
      clock.advance(10_000);
      await bounded(pong.promise);
    }
    clock.advance(10_000);
    expect(opened.filter((entry) => entry.url.searchParams.has("warm"))).toHaveLength(1);
    clock.advance(1000);
    await bounded(warmOpened[1]!.promise);
    expect(opened.map((entry) => entry.url.searchParams.get("warm"))).toEqual([null, generation, generation]);
  } finally {
    await link.stop();
    await server.stop(true);
  }
});

it("drops and reconnects a control socket that sends an oversized message after the proof", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const identity = loadRelayIdentity(fixture.stateDir);
  const lost = deferred<string>();
  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      open(socket) {
        socket.send(serverChallenge(importPublicKey(identity.public_key), { server_id: identity.server_id, role: "control", connection_id: null }).frame);
      },
      // valid JSON the link would otherwise read as a pong
      message(socket) { socket.send(JSON.stringify({ type: "pong", padding: "x".repeat(8192) })); },
    },
  });
  const link = new RelayLink({
    relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
    clock, random: () => 0.5, connect: (url) => { attempts++; return new WebSocket(url); },
    onState: (phase, error) => { if (phase === "error" && error) lost.resolve(error); },
  });
  try {
    link.start();
    expect(await bounded(lost.promise)).toContain("reconnecting");
    clock.advance(1000);
    expect(attempts).toBe(2);
  } finally {
    await link.stop();
    await server.stop(true);
  }
});

/** A pass for `serverId` that allows new client sessions or not; the link reads it, and checks no signature. */
async function passFor(serverId: string, newSessions: boolean): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return signRelayPass(keys.privateKey, "0badc0de", serverId, Math.floor(Date.now() / 1000), undefined, { newSessions });
}

/**
 * A link on a relay of this test's own, for what a real relay never does: it leaves a client the PC named open, loses
 * its control socket, names no pass mode. It takes the PC's proofs as they come, says `notice` of passes in `sync`
 * together with one waiting client, and passes that client's frames to the data socket the PC opens for it.
 */
async function limitedLink(notice: Record<string, unknown> | null, options: Partial<Pick<RelayLinkOptions, "pass" | "honoredPass" | "now">> = {}) {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const identity = loadRelayIdentity(fixture.stateDir);
  const key = importPublicKey(identity.public_key);
  const clock = new TestClock();
  const connectionId = "cd".repeat(16);
  /** the PC's sockets as it holds them, and what it sent on its control sockets after the proof */
  const sockets: { control: WebSocket[]; data: WebSocket[] } = { control: [], data: [] };
  const sentOnControl: string[] = [];
  const awaited: { check: (frame: string) => boolean; resolve: () => void }[] = [];
  let pong = deferred<void>();
  const dataProven = deferred<void>();
  const lost = deferred<void>();
  /** the 2 s the PC gives the relay to close a client it named is being counted */
  const closing = deferred<void>();
  const arm = clock.setTimeout.bind(clock);
  clock.setTimeout = (callback, ms) => { if (ms === 2_000) closing.resolve(); return arm(callback, ms); };
  type Peer = { role: "control" | "data"; proven: boolean };
  let relayControl: Bun.ServerWebSocket<Peer> | undefined;
  let relayData: Bun.ServerWebSocket<Peer> | undefined;
  /** the client's end: what it sends goes to the PC's data socket, and back */
  const transport: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => { relayData?.send(data); }, close: () => {} };
  const server = Bun.serve<Peer>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const role = new URL(request.url).searchParams.has("connection_id") ? "data" : "control";
      return server.upgrade(request, { data: { role, proven: false } }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        if (socket.data.role === "data") relayData = socket; else relayControl = socket;
        socket.send(serverChallenge(key, { server_id: identity.server_id, role: socket.data.role, connection_id: socket.data.role === "data" ? connectionId : null }).frame);
      },
      message(socket, message) {
        if (!socket.data.proven) {
          socket.data.proven = true;
          if (socket.data.role === "data") dataProven.resolve();
          else socket.send(JSON.stringify({ type: "sync", connection_ids: [connectionId], ...(notice === null ? {} : { relay_pass: notice }) }));
          return;
        }
        if (message === '{"type":"ping"}') { socket.send('{"type":"pong"}'); return; }
        if (socket.data.role !== "data") return;
        transport.onmessage?.(typeof message === "string" ? { data: message, isBinary: false }
          : { data: message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer, isBinary: true });
      },
    },
  });
  const link = new RelayLink({
    relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
    clock, random: () => 0.5, ...options,
    onState: (phase) => { if (phase === "error") lost.resolve(); },
    connect: (address) => {
      const socket = new WebSocket(address);
      if (new URL(address).searchParams.has("connection_id")) { sockets.data.push(socket); return socket; }
      sockets.control.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string" && !data.includes('"server_proof"') && data !== '{"type":"ping"}') {
          sentOnControl.push(data);
          for (const waiter of awaited.splice(0)) { if (waiter.check(data)) waiter.resolve(); else awaited.push(waiter); }
        }
        send(data);
      };
      socket.addEventListener("message", (event) => { if (event.data === '{"type":"pong"}') pong.resolve(); });
      return socket;
    },
  });
  stops.push(() => link.stop(), () => server.stop(true));
  link.start();
  await bounded(dataProven.promise);
  const devices = fixture.app.context.services.devices;
  return {
    link, clock, connectionId, sockets, sentOnControl, devices,
    /** The client on the PC's data socket, greeted. */
    phone: () => relayPhone(transport, identity.public_key),
    keys: () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
    closing: () => bounded(closing.promise),
    /** The relay drops the PC's control socket; settles once the PC saw it go. */
    async loseControl() { relayControl?.close(); await bounded(lost.promise); },
    /** Ten seconds pass and the relay answers the keepalive they bring. */
    async tenSeconds() { pong = deferred<void>(); clock.advance(10_000); await bounded(pong.promise); },
    passFor: (newSessions: boolean) => passFor(identity.server_id, newSessions),
  };
}

const NAMED = (connectionId: string) => JSON.stringify({ type: "new_session", connection_id: connectionId });

it("names a new device to the relay, makes no device, and closes the client's data socket itself after 2 s when the relay leaves it open", async () => {
  let pass: string | null = null;
  const relay = await limitedLink({ state: "ok", enforce_at: null, mode: "enforce" }, { pass: () => pass });
  pass = await relay.passFor(false);
  const phone = await relay.phone();
  const code = relay.devices.startPairing().code;
  await phone.pair(code, await relay.keys());
  await relay.closing();
  expect(relay.sentOnControl).toEqual([NAMED(relay.connectionId)]);
  expect(relay.devices.list(null)).toEqual([]);
  // this relay closes nobody: the PC ends the client's data socket itself, 2 s after it named it and no sooner
  relay.clock.advance(1_999);
  expect(relay.sockets.data[0]?.readyState).toBe(WebSocket.OPEN);
  relay.clock.advance(1);
  expect(relay.sockets.data[0]?.readyState).not.toBe(WebSocket.OPEN);
  // the code was neither spent nor counted as a failed pairing: asked of the store itself, it still pairs
  const later = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  expect(relay.devices.pairRelay(code, "Later", Buffer.from(await crypto.subtle.exportKey("spki", later.publicKey)).toString("base64url"))).not.toBeNull();
});

it("refuses a new device while its control socket is lost: nobody can be named, and the data socket still closes after 2 s", async () => {
  let pass: string | null = null;
  const relay = await limitedLink({ state: "ok", enforce_at: null, mode: "enforce" }, { pass: () => pass });
  pass = await relay.passFor(false);
  const phone = await relay.phone();
  // what the relay said of passes holds while the control socket is away
  await relay.loseControl();
  await phone.pair(relay.devices.startPairing().code, await relay.keys());
  await relay.closing();
  expect(relay.sentOnControl).toEqual([]);
  expect(relay.devices.list(null)).toEqual([]);
  expect(relay.sockets.data[0]?.readyState).toBe(WebSocket.OPEN);
  relay.clock.advance(2_000);
  expect(relay.sockets.data[0]?.readyState).not.toBe(WebSocket.OPEN);
});

for (const past of [false, true]) {
  it(`counts a relay that names no pass mode as enforcing only past its enforce_at (${past ? "past it: a new device is named" : "before it: a new device pairs"})`, async () => {
    const at = Date.parse("2030-01-01T00:00:00.000Z");
    let pass: string | null = null;
    // a relay from before `sync` named the mode
    const relay = await limitedLink({ state: "ok", enforce_at: new Date(at).toISOString() }, { pass: () => pass, now: () => (past ? at : at - 1) });
    pass = await relay.passFor(false);
    const phone = await relay.phone();
    await phone.pair(relay.devices.startPairing().code, await relay.keys());
    if (past) {
      await relay.closing();
      expect(relay.sentOnControl).toEqual([NAMED(relay.connectionId)]);
      expect(relay.devices.list(null)).toEqual([]);
    } else {
      await bounded(phone.admitted);
      expect(relay.sentOnControl).toEqual([]);
      expect(relay.devices.list(null)).toHaveLength(1);
    }
  });
}

it("still refuses a new device on a pass it no longer sends while the relay honors it", async () => {
  let held: string | null = null;
  // five minutes before its pass runs out with no renewal, the PC has none to send; the relay holds it to that pass a while yet
  const relay = await limitedLink({ state: "ok", enforce_at: null, mode: "enforce" }, { pass: () => null, honoredPass: () => held });
  held = await relay.passFor(false);
  const phone = await relay.phone();
  await phone.pair(relay.devices.startPairing().code, await relay.keys());
  await relay.closing();
  expect(relay.sentOnControl).toEqual([NAMED(relay.connectionId)]);
  expect(relay.devices.list(null)).toEqual([]);
});

it("names nobody once the relay holds this PC to no pass any more", async () => {
  let pass: string | null = null;
  // whoever times the pass says the relay honors it no longer: what the PC would still send is not asked
  const relay = await limitedLink({ state: "ok", enforce_at: null, mode: "enforce" }, { pass: () => pass, honoredPass: () => null });
  pass = await relay.passFor(false);
  const phone = await relay.phone();
  await phone.pair(relay.devices.startPairing().code, await relay.keys());
  await bounded(phone.admitted);
  expect(relay.sentOnControl).toEqual([]);
  expect(relay.devices.list(null)).toHaveLength(1);
});

it("sends a pass that came while its control socket was being let in, once that socket is proven", async () => {
  let asked = 0;
  // the control socket opens with pass-1; pass-2 comes before the relay's sync
  const relay = await limitedLink(null, { pass: () => (asked++ === 0 ? "pass-1" : "pass-2") });
  expect(relay.sentOnControl).toEqual([JSON.stringify({ type: "relay_pass", pass: "pass-2" })]);
});

it("holds a renewal that follows another within the relay's minute, then sends the pass held by then", async () => {
  let pass = "pass-0";
  const relay = await limitedLink(null, { pass: () => pass });
  const renewals = () => relay.sentOnControl.map((frame) => (JSON.parse(frame) as { pass?: string }).pass);
  // the first renewal on a control socket goes at once
  pass = "pass-1";
  relay.link.renewPass(pass);
  expect(renewals()).toEqual(["pass-1"]);
  // the relay would drop these two without a word and keep the PC to pass-1 (relay/core.ts RENEWAL_GAP_MS)
  pass = "pass-2";
  relay.link.renewPass(pass);
  pass = "pass-3";
  relay.link.renewPass(pass);
  expect(renewals()).toEqual(["pass-1"]);
  for (let step = 0; step < 6; step++) await relay.tenSeconds();
  relay.clock.advance(4_999);
  expect(renewals()).toEqual(["pass-1"]);
  relay.clock.advance(1);
  expect(renewals()).toEqual(["pass-1", "pass-3"]);
  // a minute after that one, the next goes at once
  for (let step = 0; step < 6; step++) await relay.tenSeconds();
  relay.clock.advance(5_000);
  pass = "pass-4";
  relay.link.renewPass(pass);
  expect(renewals()).toEqual(["pass-1", "pass-3", "pass-4"]);
});
