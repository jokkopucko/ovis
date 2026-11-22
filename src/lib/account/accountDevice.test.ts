import { describe, expect, it } from "bun:test";
import { accountDeviceId, exportAccountKey } from "../../../shared/account-records.ts";
import type { RelayDevice } from "../relay/device.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { accountDevice, AccountRowImmutableError, withAccountDevice } from "./accountDevice.ts";

const SERVER = "a".repeat(32);
const offer = { v: 1 as const, server_id: SERVER, server_public_key: "pc-key", relay: "wss://relay.ovis.example", name: "Desk" };

async function signIn() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_spki: await exportAccountKey(pair.publicKey) };
}

describe("signing in to a PC as the account's device", () => {
  it("T34: the row is this sign-in key's account row on that PC, pinned to the PC's own key", async () => {
    const key = await signIn();
    const device = accountDevice(offer, key);
    expect(device.device_id).toBe(accountDeviceId(SERVER, key.public_spki));
    expect(device.public_spki).toBe(key.public_spki);
    expect(device.private_key).toBe(key.private_key);
    expect(device.server_public_key).toBe("pc-key");
  });

  it("C3 premise: an account open never makes a saved pairing, so a launch, which reopens only saved pairings, never opens such a PC", async () => {
    const saved = new MemoryDeviceStore();
    const store = withAccountDevice(saved, accountDevice(offer, await signIn()));
    await store.update(SERVER, (current) => ({ ...current!, relay: "wss://relay2.ovis.example" } as RelayDevice));
    await store.remove(SERVER);
    expect((await store.list()).map((device) => device.server_id)).toEqual([SERVER]);
    expect(await saved.get(SERVER)).toBeUndefined();
    expect(await saved.list()).toEqual([]);
  });

  it("T40: the sign-in key stays as it is: nothing may move it to another key or relink the row", async () => {
    const key = await signIn();
    const store = withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, key));
    expect((await store.get(SERVER))?.public_spki).toBe(key.public_spki);
    await expect(store.update(SERVER, (current) => ({ ...current!, public_spki: "another" } as RelayDevice))).rejects.toThrow();
    await expect(store.update(SERVER, (current) => ({ ...current!, device_id: "0".repeat(16) } as RelayDevice))).rejects.toThrow();
    expect((await store.get(SERVER))?.public_spki).toBe(key.public_spki);
  });

  it("T34, T40: the channel's admission update (relay hints, direct carriers) goes through and is kept; the key does not move", async () => {
    const key = await signIn();
    const store = withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, key));
    const updated = await store.update(SERVER, (current) => ({ ...current!, relay: "wss://relay2.ovis.example", direct: ["ws://192.168.1.2:7318"] } as RelayDevice));
    expect(updated.relay).toBe("wss://relay2.ovis.example");
    expect((await store.get(SERVER))?.relay).toBe("wss://relay2.ovis.example");
    expect((await store.get(SERVER))?.public_spki).toBe(key.public_spki);
  });

  it("T40: an update cannot move the account row to another server ID", async () => {
    const row = accountDevice(offer, await signIn());
    const store = withAccountDevice(new MemoryDeviceStore(), row);
    await expect(store.update(SERVER, () => ({ ...row, server_id: "b".repeat(32) }))).rejects.toBeInstanceOf(AccountRowImmutableError);
    expect(await store.get(SERVER)).toEqual(row);
  });

  it("T34: other PCs keep this browser's own pairings untouched", async () => {
    const saved = new MemoryDeviceStore();
    const other = { ...accountDevice({ ...offer, server_id: "b".repeat(32) }, await signIn()), device_id: "1".repeat(16) };
    saved.devices.set(other.server_id, other);
    const store = withAccountDevice(saved, accountDevice(offer, await signIn()));
    expect(await store.get(other.server_id)).toBe(other);
  });
});
