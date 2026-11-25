import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { RelayUnreachableError, type RelaySocket } from "../shared/relay-channel.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../shared/relay-regions.ts";
import { openRelayPcTunnel, RelayPcKey, serverDialable, vouchedSupport } from "./relay-pc.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function offer(): RelayOffer {
  const publicKey = exportPublicKey(generateKeyPair().publicKey);
  return { v: 1, server_id: "ab".repeat(16), server_public_key: publicKey, relay: "wss://relay.example", code: "123456" };
}

function keyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-pc-key-"));
  dirs.push(dir);
  return join(dir, "relay-pcs", "pc.json");
}

it("saves an admitted key privately and signs in with it again", async () => {
  const path = keyPath();
  const pc = offer();
  const key = await RelayPcKey.create(path, pc, () => true);
  const [device] = await key.list();
  expect(existsSync(path)).toBe(false);
  await key.update(pc.server_id, () => ({ ...device!, device_id: "device-1" }));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const loaded = await RelayPcKey.load(path, () => true);
  expect(loaded.paired).toBe(true);
  expect(loaded.offer).toEqual({ v: 1, server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay });
});

it("reads back only carriers this server dials, at most four, from an edited key file", async () => {
  const path = keyPath();
  const pc = offer();
  const key = await RelayPcKey.create(path, pc, () => true);
  const [device] = await key.list();
  await key.update(pc.server_id, () => ({ ...device!, device_id: "device-1", direct: ["ws://192.168.0.10:7319"] }));
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  saved.direct = ["ws://8.8.8.8:7319", "wss://192.168.0.11:7319", 7, "ws://192.168.0.12:7319/v1/ws", "ws://10.0.0.1:1",
    "ws://100.64.0.7:7319", "ws://172.16.0.2:7319", "ws://169.254.0.3:7319", "ws://192.168.0.13:7319"];
  writeFileSync(path, JSON.stringify(saved));
  const loaded = await RelayPcKey.load(path, () => true);
  // Then only carriers this server dials come back (private or Tailscale, on a direct listener's port), at most four
  expect(loaded.direct).toEqual(["ws://100.64.0.7:7319", "ws://172.16.0.2:7319", "ws://192.168.0.13:7319"]);
});

it("writes no key for a PC removed while its pairing finished", async () => {
  const path = keyPath();
  const pc = offer();
  let wanted = true;
  const key = await RelayPcKey.create(path, pc, () => wanted);
  const [device] = await key.list();
  wanted = false;
  await expect(key.update(pc.server_id, () => ({ ...device!, device_id: "device-1" }))).rejects.toThrow("removed");
  expect(existsSync(path)).toBe(false);
});

function unreachable(dialed: string[]) {
  return (url: string) => {
    dialed.push(new URL(url).origin);
    const socket = { binaryType: "arraybuffer" as BinaryType, readyState: 3, send() {}, close() {},
      onmessage: null, onerror: null, onclose: null as ((event: CloseEvent) => void) | null };
    queueMicrotask(() => socket.onclose?.(new CloseEvent("close", { code: 1006 })));
    return socket;
  };
}

it("adds a PC through the global relay when its regional relay cannot be reached", async () => {
  const pc = { ...offer(), relay: REGIONAL_RELAYS[0]! };
  const key = await RelayPcKey.create(keyPath(), pc, () => true);
  const dialed: string[] = [];
  await expect(openRelayPcTunnel(pc, key, { socket: unreachable(dialed), onLost: () => {} })).rejects.toBeInstanceOf(RelayUnreachableError);
  expect(dialed).toEqual([pc.relay, GLOBAL_RELAY]);
});

it("never tries Ovis's relay for a PC on a relay of its own", async () => {
  const pc = offer();
  const key = await RelayPcKey.create(keyPath(), pc, () => true);
  const dialed: string[] = [];
  await expect(openRelayPcTunnel(pc, key, { socket: unreachable(dialed), onLost: () => {} })).rejects.toBeInstanceOf(RelayUnreachableError);
  expect(dialed).toEqual(["wss://relay.example"]);
});

it("keeps across a restart the relay the PC named on admission", async () => {
  const path = keyPath();
  const key = await RelayPcKey.create(path, { ...offer(), relay: GLOBAL_RELAY }, () => true);
  await key.update(key.offer.server_id, (current) => ({ ...(current ?? { ...key.offer, device_id: null, label: "x", public_spki: "", private_key: undefined as never }), device_id: "cd".repeat(8), relay: REGIONAL_RELAYS[0]! }));
  expect((await RelayPcKey.load(path, () => true)).offer.relay).toBe(REGIONAL_RELAYS[0]!);
});

it.each([
  ["a private address on the direct listener's own port", "ws://192.168.0.10:7319", true],
  ["a Tailscale address on the direct listener's port", "ws://100.64.0.7:7319", true],
  ["a port the system might pick, which a service may hold too", "ws://192.168.0.10:50000", false],
  ["link-local, where a cloud's metadata service answers", "ws://169.254.169.254:7319", false],
  ["a private address on a service's port", "ws://192.168.1.1:80", false],
  ["a private address on another low port", "ws://10.0.0.1:8080", false],
] as const)("dials %s: %s", (_name, carrier, expected) => {
  expect(serverDialable(carrier)).toBe(expected);
});

/** A relay socket the test drives: it assigns the connection, closes, or says nothing. */
class DrivenSocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed: number | null = null;
  get readyState(): number { return this.closed === null ? 1 : 3; }
  send(): void {}
  close(code = 1000): void { if (this.closed === null) this.closed = code; }
}

it("says a PC of the account is offline only on the relay's word that no PC answered, and unreachable for anything else", async () => {
  const offer: RelayOffer = { v: 1, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
  const probed = (act: (socket: DrivenSocket) => void) => vouchedSupport(offer, { pcAnswerMs: 50, socket: () => {
    const socket = new DrivenSocket();
    queueMicrotask(() => act(socket));
    return socket as unknown as RelaySocket;
  } });
  // the relay assigned the connection, and no PC came within the time
  const assigned = (socket: DrivenSocket): void => socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }) }));
  expect(await probed(assigned)).toBe("offline");
  // the relay turned this PC away before it assigned anything, or the socket failed saying nothing: nothing is known of that PC
  expect(await probed((socket) => socket.onclose?.(new CloseEvent("close", { code: 1013 })))).toBe("unreachable");
  expect(await probed((socket) => socket.onclose?.(new CloseEvent("close", { code: 1006 })))).toBe("unreachable");
});
