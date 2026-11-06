import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { DIRECT_CARRIER, FrameType, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { SignedInSessions } from "./admissions.ts";
import { admissionDrops, DirectCarrier, rankLanAddresses } from "./direct.ts";
import { openGate } from "./direct-gate.ts";
import type { NetworkInterfaceInfo } from "node:os";
import { loadRelayIdentity } from "./identity.ts";
import { RelayService } from "./service.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";
import { startBunRelay } from "../../relay/bun.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A PC with its relay identity and a direct carrier on loopback (a test stands in for a private address). */
async function directFixture(clock?: TestClock) {
  const fixture = relayFixture();
  const identity = loadRelayIdentity(fixture.stateDir);
  const direct = new DirectCarrier({ identity, services: fixture.app.context.services, port: fixture.app.port,
    addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true, ...(clock ? { clock } : {}) });
  await direct.start();
  cleanup.push(() => fixture.close(), () => direct.stop());
  const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.ovis.example" };
  const url = (): string => `ws://127.0.0.1:${direct.port}/v1/ws?v=1`;
  return { fixture, identity, direct, offer, url };
}

/** The phone's saved key for the PC, as the hosted app keeps it after pairing through the relay. */
function savedStore(device: Awaited<ReturnType<typeof relayDevice>>, offer: RelayOffer): RelayDeviceStore {
  let saved: RelayDevice | undefined = { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
    public_spki: device.publicKey, label: "Phone", server_public_key: offer.server_public_key, relay: offer.relay };
  return {
    get: async () => saved,
    update: async (_id, change) => (saved = change(saved)),
    list: async () => saved ? [saved] : [],
    remove: async () => { saved = undefined; },
  };
}

/** Resolves when the socket opens, rejects when it is refused or closes first. */
function opened(socket: WebSocket): Promise<void> {
  const result = deferred<void>();
  socket.onopen = () => result.resolve();
  socket.onerror = () => result.reject(new Error("refused"));
  socket.onclose = () => result.reject(new Error("closed"));
  return bounded(result.promise);
}

describe("direct carrier", () => {
  it("lets a paired device sign in over the same Noise channel, without the relay", async () => {
    // Given a PC listening directly and a phone paired with it through the relay
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    // When the phone opens its channel to the PC's address
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    // Then it is admitted as itself, and counted as a session
    expect(channel.device.device_id).toBe(device.id);
    expect(channel.role).toBe("drive");
    expect(direct.sessions).toBe(1);
  });

  it("is not the PC when the key it proves is another one", async () => {
    // Given a phone that pinned another PC's key under this PC's id
    const { fixture, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const elsewhere = relayFixture();
    cleanup.push(() => elsewhere.close());
    const other = loadRelayIdentity(elsewhere.stateDir);
    const pinned: RelayOffer = { ...offer, server_public_key: other.public_key };
    // When it reaches this address, the handshake against the pinned key fails before anything is sent
    await expect(bounded(openRelayChannel(pinned, { store: savedStore(device, pinned), socket: () => new WebSocket(url()) }))).rejects.toThrow();
  });

  it("ends a direct session when its device is removed", async () => {
    // Given a phone signed in directly
    const { fixture, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When the PC removes the device
    fixture.app.context.services.devices.revoke(device.id);
    // Then the direct session ends, and the device is not let in again
    await bounded(closed.promise);
    const again = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    expect(again).toBeInstanceOf(MuxProtocolError);
    expect((again as MuxProtocolError).code).toBe("auth_failed");
  });

  it("pairs nothing: a code sent there is refused and stays unspent", async () => {
    // Given a pairing code the PC shows
    const { fixture, offer, url } = await directFixture();
    const store = fixture.app.context.services.devices;
    const code = store.startPairing().code;
    const phone = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const empty: RelayDeviceStore = { get: async () => undefined, update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {} };
    // When a phone sends it over the direct carrier
    const error = await bounded(openRelayChannel({ ...offer, code }, { store: empty, socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    // Then it is refused, and the code still pairs through the relay's path
    expect(error).toBeInstanceOf(MuxProtocolError);
    expect((error as MuxProtocolError).code).toBe("auth_failed");
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", phone.publicKey)).toString("base64url");
    expect(store.pairRelay(code, "Phone", publicKey)).toBeTruthy();
  });

  it("lets a paired phone in once silent clients from its address are past their grace", async () => {
    // Given two sockets from the phone's address that never start a handshake, held a second
    const clock = new TestClock();
    const { fixture, offer, url } = await directFixture(clock);
    const device = await relayDevice(fixture);
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    const firstClosed = new Promise<number>((resolve) => { first.onclose = (event) => resolve(event.code); });
    clock.advance(1_000);
    // When the phone opens its channel from the same address
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    // Then it is admitted, and the oldest silent client gave way
    expect(channel.device.device_id).toBe(device.id);
    expect(await bounded(firstClosed)).toBe(1013);
  });

  it("does not let a newer attempt take the place of one still within its grace", async () => {
    // Given two clients from one address that just opened (a phone mid-handshake looks the same)
    const clock = new TestClock();
    const { url } = await directFixture(clock);
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    let firstClosed = false;
    first.onclose = () => { firstClosed = true; };
    // When a third comes at once, it is the one refused
    const third = new WebSocket(url());
    cleanup.push(() => third.close());
    await expect(opened(third)).rejects.toThrow();
    expect(firstClosed).toBe(false);
  });

  it("lets no plain request take a place", async () => {
    // Given two silent clients from one address, past their grace
    const clock = new TestClock();
    const { url } = await directFixture(clock);
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    let firstClosed = false;
    first.onclose = () => { firstClosed = true; };
    clock.advance(1_000);
    // When an ordinary GET reaches the same path, it is turned away and nobody gives way
    const response = await fetch(url().replace("ws://", "http://"));
    expect(response.status).toBe(426);
    expect(firstClosed).toBe(false);
    expect(first.readyState).toBe(WebSocket.OPEN);
  });

  it("lets no failed upgrade take a place", async () => {
    // Given two silent clients from one address, past their grace
    const clock = new TestClock();
    const { url } = await directFixture(clock);
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    let firstClosed = false;
    first.onclose = () => { firstClosed = true; };
    clock.advance(1_000);
    // When an upgrade request that the server cannot complete comes from the same address
    const response = await fetch(url().replace("ws://", "http://"), { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "not a key", "sec-websocket-version": "99" } });
    // Then it is turned away and nobody gave way
    expect(response.status).not.toBe(101);
    // a ping on the first client's own connection: its pong comes after any close the server sent it
    const fenced = await bounded(new Promise<string>((resolve) => {
      first.addEventListener("close", () => resolve("closed"));
      first.addEventListener("pong" as never, () => resolve("pong"));
      (first as unknown as { ping(): void }).ping();
    }));
    expect(fenced).toBe("pong");
    expect(firstClosed).toBe(false);
  });

  it("closes a connection from an address past its share before reading it", async () => {
    // Given eight connections from one address that never finish a request
    const { direct } = await directFixture();
    const raw = (): Promise<{ closed: Promise<void> }> => new Promise((resolve, reject) => {
      let done = (): void => {};
      const closed = new Promise<void>((settle) => { done = settle; });
      Bun.connect({ hostname: "127.0.0.1", port: direct.port!, socket: { open: () => resolve({ closed }), data() {}, close: () => done(), error: () => done() } }).catch(reject);
    });
    const held = [];
    for (let index = 0; index < 8; index++) held.push(await raw());
    // When a ninth comes, it is closed at once, unread
    const ninth = await raw();
    await bounded(ninth.closed, 2_000);
  });

  it("refuses a browser page: a socket that names an origin", async () => {
    const { url } = await directFixture();
    const page = new WebSocket(url(), { headers: { origin: "http://192.168.0.20:8080" } } as never);
    cleanup.push(() => page.close());
    await expect(opened(page)).rejects.toThrow();
  });

  it("answers only private network peers", async () => {
    // Given the default peer rule, on loopback
    const fixture = relayFixture();
    const strict = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services,
      port: fixture.app.port, addresses: () => ["127.0.0.1"], preferredPort: 0 });
    await strict.start();
    cleanup.push(() => fixture.close(), () => strict.stop());
    // Then a loopback client is refused
    await expect(opened(new WebSocket(`ws://127.0.0.1:${strict.port}/v1/ws?v=1`))).rejects.toThrow();
  });

  it("ends every direct session when it stops", async () => {
    // Given a phone signed in directly
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When direct connections stop, the session ends and nothing listens
    await direct.stop();
    await bounded(closed.promise);
    expect(direct.port).toBeNull();
  });
});

describe("a sign-in-only session", () => {
  it("refuses a comparison of digits as a sign-in failure, whatever the phone offered", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const connection = await relayConnection(fixture, { signInOnly: true });
    await connection.hello(["pair-sas", "pair-intent-pc"]);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    connection.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Phone", public_key: publicKey, commitment: Buffer.alloc(32).toString("base64url") } });
    expect(await bounded(connection.serverError)).toBe("auth_failed");
  });
});

describe("direct carriers in AUTH_OK", () => {
  it("are named only to a phone that offered them", async () => {
    // Given a PC with a direct carrier
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const carriers = ["ws://192.168.0.10:7319"];
    // When one phone offers DIRECT_CARRIER and another does not
    const offering = await relayConnection(fixture, { directCarriers: () => carriers });
    const plain = await relayConnection(fixture, { directCarriers: () => carriers });
    // Then only the one that offered is told
    expect((await offering.auth(device, [DIRECT_CARRIER])).direct).toEqual(carriers);
    expect(await plain.auth(device)).not.toHaveProperty("direct");
  });

  it("are left out when there are none", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const connection = await relayConnection(fixture, { directCarriers: () => [] });
    expect(await connection.auth(device, [DIRECT_CARRIER])).not.toHaveProperty("direct");
  });
});

describe("direct connections setting", () => {
  it("is on by default and kept off once turned off", async () => {
    // Given a relay service that offers direct connections, with the relay off
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const service = new RelayService({ stateDir: fixture.stateDir, direct: { addresses: () => [] } });
    expect(service.status().direct).toEqual({ on: true, carriers: [] });
    // When it is turned off
    await service.setDirect(false);
    // Then it says so, and a new start reads it back
    expect(JSON.parse(readFileSync(join(fixture.stateDir, "relay", "direct.json"), "utf8"))).toEqual({ on: false });
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("is absent where the server offers no direct connections", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    expect(new RelayService({ stateDir: fixture.stateDir }).status()).not.toHaveProperty("direct");
    expect(existsSync(join(fixture.stateDir, "relay", "direct.json"))).toBe(false);
  });
});

describe("addresses listened on", () => {
  const nic = (address: string): NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` });
  it("puts the default route's first, leaves out virtual adapters and keeps four", () => {
    const interfaces = { docker0: [nic("172.17.0.1")], "br-1a2b": [nic("172.18.0.1")], virbr0: [nic("192.168.122.1")], "vEthernet (WSL)": [nic("172.24.0.1")],
      eth1: [nic("10.0.0.2")], eth2: [nic("10.0.1.2")], eth3: [nic("10.0.2.2")], eth4: [nic("10.0.3.2")], wlan0: [nic("192.168.0.10")],
      tailscale0: [nic("100.100.1.1")], lo: [{ ...nic("127.0.0.1"), internal: true }] };
    expect(rankLanAddresses(interfaces, "192.168.0.10")).toEqual(["192.168.0.10", "10.0.0.2", "10.0.1.2", "10.0.2.2"]);
  });

  it("keeps a virtual adapter the default route leaves from", () => {
    expect(rankLanAddresses({ "vEthernet (Default Switch)": [nic("172.20.0.5")], docker0: [nic("172.17.0.1")] }, "172.20.0.5")).toEqual(["172.20.0.5"]);
  });

  it("takes another port when the one asked for is busy", async () => {
    // Given the preferred port held by something else
    const fixture = relayFixture();
    const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const direct = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services, port: fixture.app.port,
      addresses: () => ["127.0.0.1"], preferredPort: held.port, peerAllowed: () => true });
    cleanup.push(() => fixture.close(), () => held.stop(true), () => direct.stop());
    // When direct connections start, they listen on another one
    await direct.start();
    expect(direct.port).not.toBeNull();
    expect(direct.port).not.toBe(held.port);
  });
});

describe("signed-in sessions over every way in", () => {
  it("count against one limit, a device's oldest giving way", () => {
    const sessions = new SignedInSessions(8, 4);
    const closed: string[] = [];
    for (const name of ["r1", "r2", "d1", "d2", "d3"]) sessions.admit("phone", () => closed.push(name));
    expect(closed).toEqual(["r1"]);
    expect(sessions.size).toBe(4);
  });

  it("let a device at its share replace its own oldest even when every place is taken", () => {
    const sessions = new SignedInSessions(8, 4);
    const closed: string[] = [];
    for (const device of ["a", "b"]) for (let index = 1; index <= 4; index++) sessions.admit(device, () => closed.push(`${device}${index}`));
    sessions.admit("a", () => closed.push("a5"));
    expect(closed).toEqual(["a1"]);
    expect(sessions.size).toBe(8);
  });

  it("close a session past every place, and give places back", () => {
    const sessions = new SignedInSessions(2, 4);
    const closed: string[] = [];
    const release = sessions.admit("a", () => closed.push("a"));
    sessions.admit("b", () => closed.push("b"));
    sessions.admit("c", () => closed.push("c"));
    expect(closed).toEqual(["c"]);
    release();
    sessions.admit("d", () => closed.push("d"));
    expect(closed).toEqual(["c"]);
  });
});

describe("direct connections setting, read back", () => {
  it("stays off when the saved choice cannot be read", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    mkdirSync(join(fixture.stateDir, "relay"), { recursive: true });
    writeFileSync(join(fixture.stateDir, "relay", "direct.json"), '{ "on": fal');
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("refuses a switch without on: true or false", async () => {
    const stateDir = relayFixture();
    stateDir.close();
    const fixture = relayFixture(false, { relay: new RelayService({ stateDir: stateDir.stateDir, direct: { addresses: () => [] } }) });
    cleanup.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const response = await fetch(`${base}/api/relay/direct`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ on: "yes" }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_relay_direct");
  });
});

describe("direct connections with the relay", () => {
  /** A PC on a local relay, direct connections on loopback named as a private address. */
  async function liveFixture() {
    const relay = startBunRelay({ port: 0 });
    const holder = relayFixture();
    holder.close();
    const synced = deferred<void>();
    const service = new RelayService({
      stateDir: holder.stateDir, relay: "wss://relay.test",
      connect: (url) => {
        const target = new URL(url);
        const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
        socket.addEventListener("message", (event) => { if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve(); });
        return socket;
      },
      direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort: 0, advertise: (port) => [`ws://10.0.0.7:${port}`] },
    });
    const fixture = relayFixture(false, { stateDir: holder.stateDir, relay: service });
    cleanup.push(() => relay.stop(), () => fixture.close(), () => service.shutdown());
    service.start();
    await bounded(synced.promise);
    await service.setDirect(true);
    const identity = loadRelayIdentity(holder.stateDir);
    const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.test" };
    const port = (): string => service.status().direct!.carriers[0]!.split(":").at(-1)!;
    return { fixture, service, offer, port };
  }

  it("listen while the relay is on, end their sessions when turned off, and come back when turned on", async () => {
    // Given a PC with the relay on and a phone signed in directly
    const { fixture, service, offer, port } = await liveFixture();
    expect(service.status().direct?.carriers).toHaveLength(1);
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    expect(service.status().sessions).toBe(1);
    // When direct connections are turned off, the session ends and nothing is named
    await service.setDirect(false);
    await bounded(closed.promise);
    expect(service.status().direct).toEqual({ on: false, carriers: [] });
    // When they are turned on again, the listener is back
    await service.setDirect(true);
    expect(service.status().direct?.carriers).toHaveLength(1);
  });

  it("are told to a client that got in, in /api/health, even with the gate closed", async () => {
    // Given a PC with the relay and direct connections on, a device paired (the gate closed)
    const { fixture } = await liveFixture();
    await relayDevice(fixture);
    // When this PC asks for its health
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const health = await (await fetch(`${base}/api/health`)).json() as { lan_exposure?: { host: string; direct?: true } };
    // Then the direct listener is named, as paired-only
    expect(health.lan_exposure).toEqual({ host: "10.0.0.7", direct: true });
  });

  it("are told in /api/health while herdr does not answer", async () => {
    // Given a PC with the relay and direct connections on, whose herdr is away
    const { fixture } = await liveFixture();
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = join(fixture.stateDir, "no-herdr.sock");
    cleanup.push(() => { if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous; });
    // When this PC asks for its health
    const response = await fetch(`http://127.0.0.1:${fixture.app.port}/api/health`);
    const health = await response.json() as { error?: unknown; lan_exposure?: { host: string; direct?: true } };
    // Then the answer is the failure, and still names the direct listener
    expect(response.ok).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.lan_exposure).toEqual({ host: "10.0.0.7", direct: true });
  });

  it("stop with the relay", async () => {
    const { service } = await liveFixture();
    await service.stop();
    expect(service.status().direct).toEqual({ on: true, carriers: [] });
  });

  it("refuse the switch on a server without them", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const response = await fetch(`${base}/api/relay/direct`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
    expect(response.status).toBe(409);
  });
});

describe("who gives way to a new client", () => {
  it("lets a phone at a new address in while four addresses churn their full share every second", () => {
    // Given four LAN hosts each holding their two places, renewed within the grace
    const churn = ["192.168.0.101", "192.168.0.102", "192.168.0.103", "192.168.0.104"].flatMap((source, index) => [
      { source, order: index * 2, openedAt: 900 }, { source, order: index * 2 + 1, openedAt: 950 }]);
    // When a phone comes from an address none of them uses, it gets in without anyone giving way
    expect(admissionDrops(churn, "192.168.0.20", 1_000)).toEqual([]);
  });

  const client = (source: string, order: number, openedAt = 0) => ({ source, order, openedAt });

  it("past every place takes the busiest address's oldest client past its grace, and none within it", () => {
    const waiting = [client("10.0.0.1", 0), client("10.0.0.1", 1), ...Array.from({ length: 62 }, (_, index) => client(`10.0.${1 + (index >> 1)}.${index & 1 ? 2 : 3}`, index + 2))];
    expect(waiting).toHaveLength(64);
    expect(admissionDrops(waiting, "10.9.9.9", 500)).toBeNull();
    expect(admissionDrops(waiting, "10.9.9.9", 1_000)?.map((carrier) => carrier.order)).toEqual([0]);
  });

  it("takes an address's own oldest past its share, never another address's", () => {
    const waiting = [client("10.0.0.1", 0), client("10.0.0.2", 1), client("10.0.0.1", 2)];
    expect(admissionDrops(waiting, "10.0.0.1", 500)).toBeNull();
    expect(admissionDrops(waiting, "10.0.0.1", 1_000)?.map((carrier) => carrier.order)).toEqual([0]);
  });
});

describe("the gate in front of the direct carrier", () => {
  /** A raw TCP exchange: the gate's answer head (or "" when it closed without one), and its close. */
  async function exchange(port: number, request: string): Promise<{ answer: string; closed: Promise<void> }> {
    let answer = "";
    const head = deferred<string>();
    const closed = deferred<void>();
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: {
      data: (_socket, chunk) => { answer += Buffer.from(chunk).toString("latin1"); if (answer.includes("\r\n\r\n")) head.resolve(answer); },
      close: () => { head.resolve(answer); closed.resolve(); }, error: () => { head.resolve(answer); closed.resolve(); } } });
    cleanup.push(() => socket.end());
    socket.write(request);
    return { answer: await bounded(head.promise), closed: bounded(closed.promise) };
  }
  const upgrade = (extra = ""): string => `GET /v1/ws?v=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;

  it("ends the connection after any answer but a switch to WebSocket", async () => {
    // Given an address whose two places are taken by clients still within their grace
    const { direct, url } = await directFixture();
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    // When a third upgrade from it is refused (503, which would keep the connection alive)
    const { answer, closed } = await exchange(direct.port!, upgrade());
    // Then that answer is the last thing on the connection
    expect(answer.startsWith("HTTP/1.1 101")).toBe(false);
    await closed;
  });

  it("carries more than a megabyte to a client that reads slowly, by slowing the sender", async () => {
    // Given an upstream that switches to WebSocket and then writes 32 MiB as fast as it can
    // well past what the kernel buffers on loopback, so the gate itself has to hold back
    const total = 32 << 20;
    const blocked = deferred<void>();
    const upstream = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      data: (socket) => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        let sent = 0;
        const more = (): void => {
          while (sent < total) {
            const chunk = new Uint8Array(Math.min(64 * 1024, total - sent)).fill(7);
            const written = socket.write(chunk);
            sent += Math.max(0, written);
            if (written < chunk.byteLength) { blocked.resolve(); return; }
          }
        };
        (socket as unknown as { more: () => void }).more = more;
        more();
      },
      drain: (socket) => (socket as unknown as { more?: () => void }).more?.(),
    } });
    const gate = openGate({ hostname: "127.0.0.1", port: 0, upstreamPort: upstream.port, secret: "s", allowed: () => true, counts: new Map() });
    cleanup.push(() => gate.stop(true), () => upstream.stop(true));
    // When a client asks to upgrade and then reads nothing for a while
    let received = 0;
    const closed = deferred<void>();
    const done = deferred<void>();
    const client = await Bun.connect({ hostname: "127.0.0.1", port: gate.port, socket: {
      data: (_socket, chunk) => { received += chunk.byteLength; if (received >= total) done.resolve(); },
      close: () => closed.resolve(), error: () => closed.resolve() } });
    cleanup.push(() => client.end());
    client.pause();
    client.write("GET /v1/ws?v=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    const first = await bounded(Promise.race([blocked.promise.then(() => "slowed"), closed.promise.then(() => "closed")]));
    // Then the upstream is slowed rather than the connection cut, and everything arrives once the client reads
    expect(first).toBe("slowed");
    client.resume();
    await bounded(Promise.race([done.promise, closed.promise.then(() => { throw new Error(`closed after ${received} bytes`); })]));
    expect(received).toBeGreaterThanOrEqual(total);
  });

  it("ends the upstream and forwards nothing when the peer left while connecting", async () => {
    // Given an upstream that records what reaches it, and a connect the test holds until the peer has gone
    const forwarded: number[] = [];
    const upstreamClosed = deferred<void>();
    const upstream = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      data: (_socket, chunk) => { forwarded.push(chunk.byteLength); }, close: () => upstreamClosed.resolve() } });
    const asked = deferred<void>();
    const release = deferred<void>();
    const connect = (async (options: Parameters<typeof Bun.connect>[0]) => { asked.resolve(); await release.promise; return Bun.connect(options); }) as typeof Bun.connect;
    const gate = openGate({ hostname: "127.0.0.1", port: 0, upstreamPort: upstream.port, secret: "s", allowed: () => true, counts: new Map(), connect });
    cleanup.push(() => gate.stop(true), () => upstream.stop(true));
    const peerClosed = deferred<void>();
    const peer = await Bun.connect({ hostname: "127.0.0.1", port: gate.port, socket: { data() {}, close: () => peerClosed.resolve(), error: () => peerClosed.resolve() } });
    peer.write("GET /v1/ws?v=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await bounded(asked.promise);
    // When the peer leaves before the upstream connection is made
    peer.end();
    await bounded(peerClosed.promise);
    release.resolve();
    // Then the upstream connection is ended at once, with nothing forwarded
    await bounded(upstreamClosed.promise);
    expect(forwarded).toEqual([]);
  });

  it("names the peer it saw, whatever header the peer forged", async () => {
    // Given a carrier that records the peers it is asked about
    const fixture = relayFixture();
    const seen: (string | undefined)[] = [];
    const direct = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services, port: fixture.app.port,
      addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: (address) => { seen.push(address); return address === "127.0.0.1"; } });
    await direct.start();
    cleanup.push(() => fixture.close(), () => direct.stop());
    // When a request claims to come from elsewhere and to carry the gate's secret
    const { answer } = await exchange(direct.port!, upgrade("x-ovis-direct-peer: 10.0.0.66\r\nx-ovis-direct-gate: guess\r\n"));
    // Then the carrier saw only the real peer, and let it upgrade
    expect(answer.startsWith("HTTP/1.1 101")).toBe(true);
    expect(seen.includes("10.0.0.66")).toBe(false);
  });

  it("answers 404 for any other path, 400 for a malformed head, and closes an oversized one", async () => {
    const { direct } = await directFixture();
    expect((await exchange(direct.port!, "GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n")).answer.startsWith("HTTP/1.1 404")).toBe(true);
    expect((await exchange(direct.port!, upgrade("X-A: b\nX-Smuggled: c\r\n"))).answer.startsWith("HTTP/1.1 400")).toBe(true);
    expect((await exchange(direct.port!, upgrade("X-A: b\r\n folded\r\n"))).answer.startsWith("HTTP/1.1 400")).toBe(true);
    const big = await exchange(direct.port!, `GET /v1/ws HTTP/1.1\r\nX-Big: ${"a".repeat(9 * 1024)}`);
    expect(big.answer).toBe("");
    await big.closed;
  });
});
