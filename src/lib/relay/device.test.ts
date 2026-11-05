import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../../../server/devices.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { getDevice, ServerIdentityChangedError, sign } from "./device.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";

export class MemoryDeviceStore implements RelayDeviceStore {
  readonly devices = new Map<string, RelayDevice>();
  async get(id: string): Promise<RelayDevice | undefined> { return this.devices.get(id); }
  async update(id: string, change: (device: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice> {
    const next = change(this.devices.get(id));
    this.devices.set(id, next);
    return next;
  }
  async list(): Promise<RelayDevice[]> { return [...this.devices.values()]; }
  async remove(id: string): Promise<void> { this.devices.delete(id); }
}

export function testOffer(): RelayOffer {
  return { v: 1, server_id: "12".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
}

/** What channel.ts does once the PC admits the device: the key is saved with its device id. */
function admit(store: MemoryDeviceStore, device: RelayDevice): Promise<RelayDevice> {
  return store.update(device.server_id, (current) => ({ ...(current ?? device), device_id: "ab".repeat(8) }));
}

it("keeps the private key non-extractable and reuses the stored identity", async () => {
  // Given an empty device store.
  const store = new MemoryDeviceStore();
  const offer = testOffer();
  // When a device is created, admitted, and loaded again.
  const first = await admit(store, await getDevice(offer, store));
  const second = await getDevice(offer, store);
  // Then the same signing key survives, without a private export.
  expect(second.private_key).toBe(first.private_key);
  expect(first.private_key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("pkcs8", first.private_key)).rejects.toThrow();
});

it("signs the exact message accepted by DeviceStore.matchRelay", async () => {
  // Given a server registry enrolled with the client's real SPKI.
  const dir = mkdtempSync(join(tmpdir(), "relay-device-"));
  try {
    const device = await getDevice(testOffer(), new MemoryDeviceStore());
    const server = new DeviceStore(dir);
    const code = server.startPairing().code;
    const paired = server.pairRelay(code, device.label, device.public_spki);
    if (!paired) throw new Error("Fixture pairing failed");
    const nonce = new Uint8Array(32).fill(7);
    // When the client signs the challenge.
    const signature = await sign(device, nonce, device.server_id);
    // Then the actual server verifier admits it and refuses altered context.
    expect(await server.matchRelay(paired.device.id, nonce, signature, device.server_id)).toEqual(paired.device);
    expect(await server.matchRelay(paired.device.id, nonce, signature, "34".repeat(16))).toBeNull();
    expect(await server.matchRelay(paired.device.id, new Uint8Array(32), signature, device.server_id)).toBeNull();
    console.log("SIGN: non-extractable P-256; raw r||s signature accepted by DeviceStore.matchRelay; changed server_id and nonce rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("refuses a changed server key without replacing the stored identity", async () => {
  // Given an existing pinned server.
  const store = new MemoryDeviceStore();
  const offer = testOffer();
  const device = await admit(store, await getDevice(offer, store));
  // When an offer reuses its id with a different key.
  const changed = { ...offer, server_public_key: testOffer().server_public_key };
  // Then a typed error leaves the old identity intact.
  await expect(getDevice(changed, store)).rejects.toBeInstanceOf(ServerIdentityChangedError);
  expect(await store.get(offer.server_id)).toBe(device);
});

it("saves no key for a PC before the PC admits the device", async () => {
  // Given an empty device store.
  const store = new MemoryDeviceStore();
  // When a first connection makes its key.
  const device = await getDevice(testOffer(), store);
  // Then the key is not kept: a link whose PC never admits it takes no PC's slot.
  expect(device.device_id).toBeNull();
  expect(await store.list()).toEqual([]);
});

it("rejects malformed challenges before signing", async () => {
  // Given a valid client identity.
  const device = await getDevice(testOffer(), new MemoryDeviceStore());
  // When a nonce or server context is invalid.
  // Then it cannot produce an authentication signature.
  await expect(sign(device, new Uint8Array(31), device.server_id)).rejects.toThrow(TypeError);
  await expect(sign(device, new Uint8Array(32), "34".repeat(16))).rejects.toThrow(TypeError);
});
