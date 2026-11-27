import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairedDevice } from "../../shared/access.ts";
import { openRelayChannel, probePc } from "../../shared/relay-channel.ts";
import type { RelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { DIRECT_CARRIER, DIRECT_TAILNET, FrameType, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { CHECK_GAP_MS, SignedInSessions } from "./admissions.ts";
import type { Access } from "../access.ts";
import { handleDeviceRequest } from "../devices.ts";
import type { DeviceStore } from "../devices.ts";
import { admissionDrops, directPeerAllowed, DirectCarrier, rankLanAddresses, tailnetAddresses } from "./direct.ts";
import { openGate } from "./direct-gate.ts";
import type { NetworkInterfaceInfo } from "node:os";
import { loadRelayIdentity } from "./identity.ts";
import { MIN_SUPPORTED_CLIENT_VERSION } from "./client-floor.ts";
import { RelayService } from "./service.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";
import { startBunRelay } from "../../relay/bun.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function directFixture(clock?: TestClock, minSupportedClient?: string) {
  const fixture = relayFixture();
  const identity = loadRelayIdentity(fixture.stateDir);
  const direct = new DirectCarrier({ identity, services: fixture.app.context.services, port: fixture.app.port,
    addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true, ...(clock ? { clock } : {}), ...(minSupportedClient ? { minSupportedClient } : {}) });
  await direct.start();
  cleanup.push(() => fixture.close(), () => direct.stop());
  const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.ovis.example" };
  const url = (): string => `ws://127.0.0.1:${direct.port}/v1/ws?v=1`;
  return { fixture, identity, direct, offer, url };
}

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

function opened(socket: WebSocket): Promise<void> {
  const result = deferred<void>();
  socket.onopen = () => result.resolve();
  socket.onerror = () => result.reject(new Error("refused"));
  socket.onclose = () => result.reject(new Error("closed"));
  return bounded(result.promise);
}

describe("direct carrier", () => {
  it("lets a paired device sign in over the same Noise channel, without the relay", async () => {
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    expect(channel.device.device_id).toBe(device.id);
    expect(channel.role).toBe("drive");
    expect(direct.sessions).toBe(1);
  });

  it("names the oldest client it supports in its WELCOME, as the relay link does", async () => {
    const { fixture, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    expect(channel.server.minSupportedClient).toBe(MIN_SUPPORTED_CLIENT_VERSION);
    const raised = await directFixture(undefined, "9.8.7");
    const raisedDevice = await relayDevice(raised.fixture);
    const again = await bounded(openRelayChannel(raised.offer, { store: savedStore(raisedDevice, raised.offer), socket: () => new WebSocket(raised.url()) }));
    cleanup.push(() => again.close());
    expect(again.server.minSupportedClient).toBe("9.8.7");
  });

  it("is not the PC when the key it proves is another one", async () => {
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

  it("refuses the app's own pages' origins alike, hosted or carried by the iOS app: only the plugin's socket, which names none, opens it", async () => {
    const { fixture, offer, url } = await directFixture();
    for (const origin of ["https://app.ovis.sh", "capacitor://app.ovis.sh", "capacitor://localhost"]) {
      const page = new WebSocket(url(), { headers: { origin } } as never);
      cleanup.push(() => page.close());
      await expect(opened(page)).rejects.toThrow();
    }
    const device = await relayDevice(fixture);
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    expect(channel.device.device_id).toBe(device.id);
  });

  it("answers only private network peers", async () => {
    const fixture = relayFixture();
    const strict = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services,
      port: fixture.app.port, addresses: () => ["127.0.0.1"], preferredPort: 0 });
    await strict.start();
    cleanup.push(() => fixture.close(), () => strict.stop());
    // Then a loopback client is refused
    await expect(opened(new WebSocket(`ws://127.0.0.1:${strict.port}/v1/ws?v=1`))).rejects.toThrow();
  });

  it("ends every direct session when it stops", async () => {
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
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

  it("name the Tailscale one only to a phone that also offered DIRECT_TAILNET", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const carriers = (tailnet: boolean): string[] => ["ws://192.168.0.10:7319", ...tailnet ? ["ws://100.64.0.7:7319"] : []];
    // When one phone offers both features and another DIRECT_CARRIER alone
    const both = await relayConnection(fixture, { directCarriers: carriers });
    const lanOnly = await relayConnection(fixture, { directCarriers: carriers });
    // Then only the first hears of the Tailscale address
    expect((await both.auth(device, [DIRECT_CARRIER, DIRECT_TAILNET])).direct).toEqual(["ws://192.168.0.10:7319", "ws://100.64.0.7:7319"]);
    expect((await lanOnly.auth(device, [DIRECT_CARRIER])).direct).toEqual(["ws://192.168.0.10:7319"]);
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
  const choice = (stateDir: string): string => join(stateDir, "relay", "direct.json");
  const choose = (stateDir: string, text: string): void => {
    mkdirSync(join(stateDir, "relay"), { recursive: true });
    writeFileSync(choice(stateDir), text);
  };

  it("is off on a new install, and kept on once turned on", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const service = new RelayService({ stateDir: fixture.stateDir, direct: { addresses: () => [] } });
    expect(service.status().direct).toEqual({ on: false, carriers: [] });
    // reading the default records no choice
    expect(existsSync(choice(fixture.stateDir))).toBe(false);
    // When it is turned on
    await service.setDirect(true);
    // Then it says so, and a new start reads it back
    expect(JSON.parse(readFileSync(choice(fixture.stateDir), "utf8"))).toEqual({ on: true });
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(true);
    await service.setDirect(false);
    expect(JSON.parse(readFileSync(choice(fixture.stateDir), "utf8"))).toEqual({ on: false });
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("keeps a choice saved before the default changed: turned on stays on, turned off stays off", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    loadRelayIdentity(fixture.stateDir);
    choose(fixture.stateDir, '{"on":true}');
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(true);
    choose(fixture.stateDir, '{"on":false}');
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("is off on an install that only ever had the old default, which saved no choice", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    // an install that ran the relay before (its identity and relay state on disk) and never touched the switch
    loadRelayIdentity(fixture.stateDir);
    writeFileSync(join(fixture.stateDir, "relay", "state.json"), '{"enabled":true}');
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
    expect(existsSync(choice(fixture.stateDir))).toBe(false);
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

  it("takes the Tailscale address only on Tailscale's adapter, never a shared address on a real adapter or another VPN's tunnel", () => {
    const cases: [string, NodeJS.Dict<NetworkInterfaceInfo[]>, string | null, string[]][] = [
      ["Linux tailscale0", { eth0: [nic("192.168.0.10")], tailscale0: [nic("100.101.102.103")] }, null, ["100.101.102.103"]],
      ["Windows adapter", { Tailscale: [nic("100.64.0.2")] }, null, ["100.64.0.2"]],
      ["macOS utun with the address tailscale names", { utun4: [nic("100.127.255.254")] }, "100.127.255.254", ["100.127.255.254"]],
      ["a utun while tailscale names none (another VPN's, maybe)", { utun4: [nic("100.72.1.2")] }, null, []],
      ["another utun than the one tailscale names", { utun3: [nic("100.70.0.1")], utun5: [nic("100.80.0.9")] }, "100.80.0.9", ["100.80.0.9"]],
      ["ISP shared address space on a real adapter", { eth0: [nic("100.72.1.2")] }, null, []],
      ["a stale status naming a real adapter's shared address", { eth0: [nic("100.72.1.2")] }, "100.72.1.2", []],
      ["outside Tailscale's range", { tailscale0: [nic("100.128.0.1")] }, null, []],
      ["tailscale names an address no adapter has (it moved): Tailscale's adapter still counts", { tailscale0: [nic("100.90.0.1")] }, "100.90.0.2", ["100.90.0.1"]],
      ["tailscale names an address no adapter has, and only another VPN's utun is up", { utun4: [nic("100.96.0.3")] }, "100.90.0.2", []],
    ];
    for (const [name, interfaces, known, expected] of cases) expect(tailnetAddresses(interfaces, known), name).toEqual(expected);
  });

  it("lets only Tailscale peers reach the Tailscale listener, and only private peers the others", () => {
    expect(directPeerAllowed("100.64.0.7", "100.101.102.103")).toBe(true);
    expect(directPeerAllowed("100.64.0.7", "::ffff:100.101.102.103")).toBe(true);
    expect(directPeerAllowed("100.64.0.7", "192.168.0.20")).toBe(false);
    expect(directPeerAllowed("100.64.0.7", "8.8.8.8")).toBe(false);
    expect(directPeerAllowed("192.168.0.10", "192.168.0.20")).toBe(true);
    expect(directPeerAllowed("192.168.0.10", "100.101.102.103")).toBe(false);
  });

  it("keeps a virtual adapter the default route leaves from", () => {
    expect(rankLanAddresses({ "vEthernet (Default Switch)": [nic("172.20.0.5")], docker0: [nic("172.17.0.1")] }, "172.20.0.5")).toEqual(["172.20.0.5"]);
  });

  it("takes another port when the one asked for is busy", async () => {
    const fixture = relayFixture();
    const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const direct = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services, port: fixture.app.port,
      addresses: () => ["127.0.0.1"], preferredPort: held.port, peerAllowed: () => true });
    cleanup.push(() => fixture.close(), () => held.stop(true), () => direct.stop());
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

  it("let a carrier an app may still drop make none of its device's sessions give way until it is used", () => {
    const sessions = new SignedInSessions(8, 4);
    const closed: string[] = [];
    for (const name of ["s1", "s2", "s3"]) sessions.admit("phone", () => closed.push(name));
    const lanCarrier = sessions.candidate("phone", () => closed.push("lan"));
    const tailnetCarrier = sessions.candidate("phone", () => closed.push("tailnet"));
    expect(closed).toEqual([]);
    lanCarrier.release();
    tailnetCarrier.chosen();
    expect(closed).toEqual([]);
    sessions.admit("phone", () => closed.push("s5"));
    expect(closed).toEqual(["s1"]);
  });

  it("close the oldest carrier past a device's racing ones, never a session it uses", () => {
    const sessions = new SignedInSessions(8, 4, 3);
    const closed: string[] = [];
    sessions.admit("phone", () => closed.push("s1"));
    for (const name of ["c1", "c2", "c3", "c4"]) sessions.candidate("phone", () => closed.push(name));
    expect(closed).toEqual(["c1"]);
  });

  it("name a device's connection by the session it uses, not a racing carrier it may drop", () => {
    const sessions = new SignedInSessions(8, 4);
    const mux = { active: true, rttMs: 40, measure: async () => 40 };
    sessions.admit("phone", () => {}, { route: "relay", relay: "wss://relay-ap.ovis.sh", since: 1_000, mux });
    sessions.candidate("phone", () => {}, { route: "lan", since: 2_000, mux });
    expect(sessions.connections().get("phone")?.route).toBe("relay");
  });

  it("let each device at its share race its own carriers past every place, so one device's never shut another out (#3243)", () => {
    // Given every place taken by two devices at their share, and one of them holding three carriers it never uses
    const sessions = new SignedInSessions(8, 4, 3);
    const closed: string[] = [];
    for (const device of ["a", "b"]) for (let index = 1; index <= 4; index++) sessions.admit(device, () => closed.push(`${device}${index}`));
    for (let index = 1; index <= 3; index++) sessions.candidate("a", () => closed.push(`a-c${index}`));
    // When the other signs in a carrier and uses it
    sessions.candidate("b", () => closed.push("b-new")).chosen();
    // Then it replaces its own oldest session, and nothing of the first device's is closed
    expect(closed).toEqual(["b1"]);
    expect(sessions.size).toBe(11);
  });

  it("hold past every place at most each device's own racing carriers, for each device at its share", () => {
    const sessions = new SignedInSessions(8, 4, 3);
    const closed: string[] = [];
    for (const device of ["a", "b"]) for (let index = 1; index <= 4; index++) sessions.admit(device, () => closed.push(`${device}${index}`));
    for (const device of ["a", "b"]) for (let index = 1; index <= 4; index++) sessions.candidate(device, () => closed.push(`${device}-c${index}`));
    // eight places, and three carriers for each of the two devices at its share: a fourth closes its own oldest
    expect(sessions.size).toBe(14);
    expect(closed).toEqual(["a-c1", "b-c1"]);
  });

  it("name each device's connection: its nearest way in, with the latest round trip, until released", () => {
    const sessions = new SignedInSessions(8, 4);
    const mux = (rttMs: number | undefined, active = true) => ({ active, rttMs, measure: async () => rttMs });
    sessions.admit("phone", () => {}, { route: "relay", relay: "wss://relay-ap.ovis.sh", since: 1_000, mux: mux(48) });
    const direct = sessions.admit("phone", () => {}, { route: "lan", since: 2_000, mux: mux(undefined) });
    sessions.admit("laptop", () => {}, { route: "tailscale", since: 3_000, mux: mux(21) });
    sessions.admit("script", () => {});
    sessions.admit("phone", () => {}, { route: "lan", since: 4_000, mux: mux(5, false) });
    expect(Object.fromEntries(sessions.connections())).toEqual({
      phone: { route: "lan", rtt_ms: null, since: new Date(2_000).toISOString() },
      laptop: { route: "tailscale", rtt_ms: 21, since: new Date(3_000).toISOString() },
    });
    direct();
    expect(sessions.connections().get("phone")).toEqual({ route: "relay", relay: "wss://relay-ap.ovis.sh", rtt_ms: 48, since: new Date(1_000).toISOString() });
  });

  it("check every connection now, giving up on one that does not answer in time", async () => {
    const sessions = new SignedInSessions(8, 4);
    let fast: number | undefined;
    sessions.admit("phone", () => {}, { route: "lan", since: 0, mux: { active: true, get rttMs() { return fast; }, measure: async () => (fast = 9) } });
    sessions.admit("laptop", () => {}, { route: "relay", relay: "wss://relay.ovis.sh", since: 0, mux: { active: true, rttMs: 300, measure: () => new Promise<number | undefined>(() => {}) } });
    await sessions.check(20);
    expect(sessions.connections().get("phone")?.rtt_ms).toBe(9);
    expect(sessions.connections().get("laptop")?.rtt_ms).toBe(300);
  });

  it("share one check among callers at once, and measure nothing again right after", async () => {
    const sessions = new SignedInSessions(8, 4);
    let measured = 0;
    sessions.admit("phone", () => {}, { route: "lan", since: 0, mux: { active: true, rttMs: 9, measure: async () => { measured++; return 9; } } });
    await Promise.all([sessions.check(20, 10_000), sessions.check(20, 10_000)]);
    await sessions.check(20, 10_000 + CHECK_GAP_MS - 1);
    expect(measured).toBe(1);
    await sessions.check(20, 10_000 + CHECK_GAP_MS);
    expect(measured).toBe(2);
  });

  it("tell how other devices are connected, and check them, only to a caller that may manage them", async () => {
    const sessions = new SignedInSessions(8, 4);
    let measured = 0;
    sessions.admit("00112233445566aa", () => {}, { route: "tailscale", since: 0, mux: { active: true, rttMs: 33, measure: async () => { measured++; return 33; } } });
    const row: PairedDevice = { id: "00112233445566aa", label: "Phone", role: "drive", created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null, current: false, via_relay: true };
    const store = { error: null, list: () => [row], listAccountJoined: () => [], opensAll: () => false, accountPolicyActive: () => false } as unknown as DeviceStore;
    const connections = { list: () => sessions.connections(), check: (ms: number) => sessions.check(ms) };
    const read = async (access: Access) => ((await (await handleDeviceRequest(new Request("http://127.0.0.1/api/devices?check=1"), "/api/devices", store, access, null, undefined, false, connections)).json()) as { devices: PairedDevice[] }).devices[0]?.connection;
    expect(await read({ level: "full", via: "relay", role: "watch" })).toBeUndefined();
    expect(await read({ level: "full", via: "portal", role: "drive" })).toBeUndefined();
    expect(measured).toBe(0);
    expect(await read({ level: "full", via: "local", role: "drive" })).toEqual({ route: "tailscale", rtt_ms: 33, since: new Date(0).toISOString() });
    expect(measured).toBe(1);
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
  async function liveFixture(advertise: (port: number) => readonly string[] = (port) => [`ws://10.0.0.7:${port}`], { turnOn = true, preferredPort = 0 }: { turnOn?: boolean; preferredPort?: number } = {}) {
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
      direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort, advertise },
    });
    const fixture = relayFixture(false, { stateDir: holder.stateDir, relay: service });
    cleanup.push(() => relay.stop(), () => fixture.close(), () => service.shutdown());
    service.start();
    await bounded(synced.promise);
    if (turnOn) await service.setDirect(true);
    const identity = loadRelayIdentity(holder.stateDir);
    const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.test" };
    const port = (): string => service.status().direct!.carriers[0]!.split(":").at(-1)!;
    return { fixture, service, offer, port, relay };
  }

  it("bind no listener on a PC that never turned them on: the relay alone carries its devices", async () => {
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const preferredPort = free.port;
    free.stop(true);
    const { fixture, service, offer, relay } = await liveFixture(undefined, { turnOn: false, preferredPort });
    const device = await relayDevice(fixture);
    const listening = async (): Promise<boolean> => {
      const socket = new WebSocket(`ws://127.0.0.1:${preferredPort}/v1/ws?v=1`);
      try { await opened(socket); return true; } catch { return false; } finally { socket.close(); }
    };
    // Then nothing listens on the direct port, /api/health names no listener, and a phone that offers to take
    // direct carriers is told none
    expect(service.status().direct).toEqual({ on: false, carriers: [] });
    expect(await listening()).toBe(false);
    const health = await (await fetch(`http://127.0.0.1:${fixture.app.port}/api/health`)).json() as { direct_exposure?: unknown };
    expect(health.direct_exposure).toBeUndefined();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), offerDirect: true, offerTailnet: true, socket: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    } }));
    cleanup.push(() => channel.close());
    expect(channel.directCarriers).toEqual([]);
    // When the owner turns them on, the same PC listens there
    await service.setDirect(true);
    expect(service.status().direct?.carriers).toEqual([`ws://10.0.0.7:${preferredPort}`]);
    expect(await listening()).toBe(true);
  });

  it("let a direct carrier signed in but never used close none of its device's sessions, until it opens a stream", async () => {
    const { fixture, offer, port } = await liveFixture();
    const device = await relayDevice(fixture);
    const open = () => bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`) }));
    const use = (channel: RelayChannel) => bounded(new Promise<number>((resolve, reject) => {
      const stream = channel.mux.openHttp({ target: "/api/relay", method: "GET", headers: [], body: "none" });
      stream.onHeaders = ({ status }) => { if (status >= 200) { resolve(status); void stream.body.cancel(); } };
      stream.onDispose = (failure) => { if (failure) reject(failure); };
    }));
    const firstClosed = deferred<void>();
    const first = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`), onClose: () => firstClosed.resolve() }));
    expect(await use(first)).toBe(200);
    const inUse = [first];
    for (let index = 0; index < 3; index += 1) {
      inUse.push(await open());
      expect(await use(inUse.at(-1)!)).toBe(200);
    }
    const racing = await open();
    cleanup.push(...[...inUse, racing].map((channel) => () => channel.close()));
    for (const channel of inUse) expect(await use(channel)).toBe(200);
    expect(await use(racing)).toBe(200);
    await bounded(firstClosed.promise);
  });

  it("answer a probe through the relay with no session, and tell a silent PC from an unreachable relay", async () => {
    const { service, offer, relay } = await liveFixture();
    const through = (url: string) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    };
    // When a phone probes it through the relay, it answers within one handshake, and holds no session for it
    const answered = await bounded(probePc(offer, { relay: offer.relay }, through, 5_000));
    expect(answered.kind).toBe("answered");
    expect(service.status().sessions).toBe(0);
    expect(await bounded(probePc({ ...offer, server_id: "ab".repeat(16) }, { relay: offer.relay }, through, 300))).toEqual({ kind: "silent" });
    expect(await bounded(probePc(offer, { relay: offer.relay }, () => new WebSocket("ws://127.0.0.1:1/v1/ws"), 5_000))).toEqual({ kind: "unreachable" });
  });

  it("tell /api/devices how each device reaches the PC now, and measure its round trip on ?check=1", async () => {
    const { fixture, offer, port, relay } = await liveFixture();
    const near = await relayDevice(fixture);
    const away = await relayDevice(fixture);
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const listed = async (query = "") => new Map(((await (await fetch(`${base}/api/devices${query}`)).json()) as { devices: PairedDevice[] }).devices.map((d) => [d.id, d.connection]));
    expect((await listed()).get(near.id)).toBeUndefined();
    const direct = await bounded(openRelayChannel(offer, { store: savedStore(near, offer), socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`) }));
    const relayed = await bounded(openRelayChannel(offer, { store: savedStore(away, offer), socket: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    } }));
    cleanup.push(() => direct.close(), () => relayed.close());
    const now = await listed();
    expect(now.get(near.id)).toMatchObject({ route: "lan", rtt_ms: null });
    expect(now.get(away.id)).toMatchObject({ route: "relay", relay: "wss://relay.test", rtt_ms: null });
    const checked = await listed("?check=1");
    expect(checked.get(near.id)?.rtt_ms).toBeGreaterThanOrEqual(0);
    expect(checked.get(away.id)?.rtt_ms).toBeGreaterThanOrEqual(0);
  });

  it("listen while the relay is on, end their sessions when turned off, and come back when turned on", async () => {
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
    await service.setDirect(true);
    expect(service.status().direct?.carriers).toHaveLength(1);
  });

  it("name the PC's Tailscale address in AUTH_OK only to an app that can open it", async () => {
    const { fixture, offer, port } = await liveFixture((listened) => [`ws://10.0.0.7:${listened}`, `ws://100.64.0.7:${listened}`]);
    const device = await relayDevice(fixture);
    const open = (offerTailnet: boolean) => bounded(openRelayChannel(offer, { store: savedStore(device, offer),
      socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`), offerDirect: true, offerTailnet }));
    // When an app that opens Tailscale addresses signs in, and then one that does not
    const tailnet = await open(true);
    cleanup.push(() => tailnet.close());
    const lan = await open(false);
    cleanup.push(() => lan.close());
    // Then only the first is told the Tailscale carrier
    expect(tailnet.directCarriers).toEqual([`ws://10.0.0.7:${port()}`, `ws://100.64.0.7:${port()}`]);
    expect(lan.directCarriers).toEqual([`ws://10.0.0.7:${port()}`]);
  });

  it("are told to a client that got in, in /api/health, even with the gate closed", async () => {
    const { fixture } = await liveFixture();
    await relayDevice(fixture);
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const health = await (await fetch(`${base}/api/health`)).json() as { lan_exposure?: unknown; direct_exposure?: unknown };
    // Then the direct listener is named in a field of its own: a 0.4.x client takes any lan_exposure for an open server
    expect(health.direct_exposure).toEqual({ host: "10.0.0.7" });
    expect(health.lan_exposure).toBeUndefined();
  });

  it("are told in /api/health while herdr does not answer", async () => {
    const { fixture } = await liveFixture();
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = join(fixture.stateDir, "no-herdr.sock");
    cleanup.push(() => { if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous; });
    const response = await fetch(`http://127.0.0.1:${fixture.app.port}/api/health`);
    const health = await response.json() as { error?: unknown; lan_exposure?: unknown; direct_exposure?: unknown };
    expect(response.ok).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.direct_exposure).toEqual({ host: "10.0.0.7" });
    expect(health.lan_exposure).toBeUndefined();
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
    expect(first).toBe("slowed");
    client.resume();
    await bounded(Promise.race([done.promise, closed.promise.then(() => { throw new Error(`closed after ${received} bytes`); })]));
    expect(received).toBeGreaterThanOrEqual(total);
  });

  it("ends the upstream and forwards nothing when the peer left while connecting", async () => {
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
    peer.end();
    await bounded(peerClosed.promise);
    release.resolve();
    await bounded(upstreamClosed.promise);
    expect(forwarded).toEqual([]);
  });

  it("names the peer it saw, whatever header the peer forged", async () => {
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
