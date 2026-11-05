import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { RelayPcKey } from "./relay-pc.ts";

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
