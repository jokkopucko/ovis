import { afterEach, expect, test } from "bun:test";
import { DEFAULT_RELAY_LIMITS, memoryLimiters, relayLimits, relayLimitsFromArgs } from "./bun-limits.ts";
import { startBunRelay } from "./bun.ts";
import { admit } from "./core.ts";
import { Peer, newServer, relayUrls } from "./relay-test-client.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });
const upgrade = { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } };
const request = () => new Request(relayUrls("http://relay.test", newServer()).client, upgrade);
const status = async (response: Awaited<ReturnType<typeof admit>>) => response instanceof Response ? response.status : 101;

test("default token buckets enforce 120 per address and refill without sleeps", async () => {
  let now = 0;
  const limiters = memoryLimiters(relayLimits(), () => now);
  const req = request();
  for (let i = 0; i < 120; i++) expect(await status(await admit(req, "a", limiters))).toBe(101);
  expect(await status(await admit(req, "a", limiters))).toBe(429);
  now = 499;
  expect(await status(await admit(req, "a", limiters))).toBe(429);
  now = 500;
  expect(await status(await admit(req, "a", limiters))).toBe(101);
  expect(await status(await admit(req, "a", limiters))).toBe(429);
});

test("global default stops the 601st connection across addresses", async () => {
  const limiters = memoryLimiters(relayLimits(), () => 0);
  const req = request();
  for (let i = 0; i < 600; i++) expect(await status(await admit(req, `ip-${i}`, limiters))).toBe(101);
  const refused = await admit(req, "another", limiters);
  expect(await status(refused)).toBe(429);
  if (refused instanceof Response) expect(refused.headers.get("retry-after")).toBe("60");
});

test("address bookkeeping fails closed at its cap and reclaims only idle buckets", async () => {
  let now = 0;
  const limits = memoryLimiters(relayLimits({ maxAddresses: 2, perAddressPerMinute: 1 }), () => now);
  expect(await limits.perAddress.limit({ key: "a" })).toEqual({ success: true });
  expect(await limits.perAddress.limit({ key: "b" })).toEqual({ success: true });
  expect(await limits.perAddress.limit({ key: "c" })).toEqual({ success: false });
  expect(await limits.perAddress.limit({ key: "a" })).toEqual({ success: false });
  now = 60_000;
  expect(await limits.perAddress.limit({ key: "c" })).toEqual({ success: true });
});

test("flags override environment values and invalid budgets fail startup", () => {
  const limits = relayLimitsFromArgs(["--max-sockets", "9", "--per-address-per-minute", "7", "--max-sockets-per-address", "5"], {
    RELAY_MAX_SOCKETS: "8", RELAY_PER_ADDRESS_PER_MINUTE: "6", RELAY_MAX_ROOMS: "3",
    RELAY_GLOBAL_PER_MINUTE: "17", RELAY_MAX_ADDRESSES: "11", RELAY_MAX_SOCKETS_PER_ADDRESS: "4",
  });
  expect(limits).toEqual({ maxSockets: 9, perAddressPerMinute: 7, maxRooms: 3, globalPerMinute: 17, maxAddresses: 11, maxSocketsPerAddress: 5 });
  expect(relayLimitsFromArgs([], { RELAY_MAX_SOCKETS_PER_ADDRESS: "4" }).maxSocketsPerAddress).toBe(4);
  for (const value of ["0", "-1", "NaN", "1.5", "Infinity", "", "9007199254740992"]) {
    expect(() => relayLimitsFromArgs(["--max-sockets", value], {})).toThrow();
    expect(() => relayLimitsFromArgs([], { RELAY_MAX_ROOMS: value })).toThrow();
    expect(() => relayLimitsFromArgs(["--max-sockets-per-address", value], {})).toThrow();
  }
  expect(() => relayLimitsFromArgs(["--max-rooms"], {})).toThrow();
});

test("Bun starts with default rate limiting and ignores spoofed forwarding addresses", async () => {
  const relay = startBunRelay({ port: 0, limiters: memoryLimiters(relayLimits(), () => 0) });
  cleanup.push(() => relay.stop());
  const base = `http://127.0.0.1:${relay.port}`;
  // Invalid WebSocket keys make upgrade fail after admission without retaining sockets.
  const headers = { ...upgrade.headers, "sec-websocket-key": "invalid" };
  for (let i = 0; i < 120; i++) {
    expect((await fetch(relayUrls(base, newServer()).client, { headers })).status).toBe(426);
  }
  const refused = await fetch(relayUrls(base, newServer()).client, {
    headers: { ...headers, "x-forwarded-for": "203.0.113.123" },
  });
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect((await fetch(`${base}/health`)).status).toBe(200);
});

test.each(["rooms", "sockets"] as const)("Bun reserves the %s cap across concurrent upgrades and releases it on close", async (cap) => {
  const relay = startBunRelay({ port: 0, limits: { maxRooms: cap === "rooms" ? 1 : 10, maxSockets: cap === "sockets" ? 1 : 10 } });
  cleanup.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}`;
  const one = new Peer(new WebSocket(relayUrls(base, newServer()).client));
  const two = new Peer(new WebSocket(relayUrls(base, newServer()).client));
  await Promise.all([one.ready, two.ready]);
  const live = one.socket.readyState === WebSocket.OPEN ? one : two;
  const refused = live === one ? two : one;
  await refused.closeCode();
  expect((await live.json())["type"]).toBe("assigned");
  const response = await fetch(relayUrls(base.replace("ws:", "http:"), newServer()).client, upgrade);
  expect(response.status).toBe(503);
  live.socket.close();
  await live.closeCode();
  const next = await Peer.open(relayUrls(base, newServer()).client);
  expect((await next.json())["type"]).toBe("assigned");
});

test("failed upgrades release room and socket reservations", async () => {
  const relay = startBunRelay({ port: 0, limits: { maxRooms: 1, maxSockets: 1 } });
  cleanup.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}`;
  const response = await fetch(relayUrls(base.replace("ws:", "http:"), newServer()).client, {
    headers: { ...upgrade.headers, "sec-websocket-key": "invalid" },
  });
  expect(response.status).toBe(426);
  const peer = await Peer.open(relayUrls(base, newServer()).client);
  expect((await peer.json())["type"]).toBe("assigned");
});

test("one address cannot hold more than its share of open sockets, waiting or connected, and gets its place back on close", async () => {
  // the default budgets but for the rate: one address opening sockets as fast as it may
  const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
  cleanup.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}`;
  const held: Peer[] = [];
  // each in its own room, all waiting for a PC that never comes
  for (let i = 0; i < DEFAULT_RELAY_LIMITS.maxSocketsPerAddress; i++) {
    const peer = await Peer.open(relayUrls(base, newServer()).client);
    expect((await peer.json())["type"]).toBe("assigned");
    held.push(peer);
  }
  // far below the room and socket caps, yet the address's next socket is refused
  const refused = await fetch(relayUrls(base.replace("ws:", "http:"), newServer()).client, upgrade);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect(await refused.text()).toBe("too many open connections from this address");
  // the refusal evicts nobody
  expect(held.every((peer) => peer.socket.readyState === WebSocket.OPEN)).toBe(true);
  held[0]!.socket.close();
  await held[0]!.closeCode();
  const next = await Peer.open(relayUrls(base, newServer()).client);
  expect((await next.json())["type"]).toBe("assigned");
});

test("a failed upgrade gives the address its place back", async () => {
  const relay = startBunRelay({ port: 0, limits: { maxSocketsPerAddress: 1 } });
  cleanup.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}`;
  const response = await fetch(relayUrls(base.replace("ws:", "http:"), newServer()).client, {
    headers: { ...upgrade.headers, "sec-websocket-key": "invalid" },
  });
  expect(response.status).toBe(426);
  const peer = await Peer.open(relayUrls(base, newServer()).client);
  expect((await peer.json())["type"]).toBe("assigned");
});

test.each([["rooms", 256], ["sockets", 1024]] as const)("Bun enforces the default %s capacity", async (cap, capacity) => {
  // every socket here comes from one address: its own cap is lifted to reach the global ones
  const relay = startBunRelay({ port: 0, limits: {
    perAddressPerMinute: 10_000, globalPerMinute: 10_000, maxSocketsPerAddress: 2048,
    ...(cap === "sockets" ? { maxRooms: 2048 } : {}),
  } });
  cleanup.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}`;
  for (let i = 0; i < capacity; i++) {
    const peer = await Peer.open(relayUrls(base, newServer()).client);
    expect((await peer.json())["type"]).toBe("assigned");
  }
  const response = await fetch(relayUrls(base.replace("ws:", "http:"), newServer()).client, upgrade);
  expect(response.status).toBe(503);
});
