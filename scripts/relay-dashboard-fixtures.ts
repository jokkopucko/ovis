/**
 * the pairings are written into the page's IndexedDB as lib/relay/device.ts writes
 * them, with a real non-extractable key.
 */
import type { Page } from "playwright-core";
import type { FakePc } from "../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";

export const ACCOUNT = "acct_github";
export const GLOBAL_RELAY = "wss://relay.ovis.sh";
export const AP_RELAY = "wss://relay-ap.ovis.sh";
const MIN = 60_000;
const DAY = 864e5;

export interface PcSpec { readonly label: string; readonly relay: string; readonly seenAgo: number | null; readonly addedAgo: number; readonly paired: boolean; readonly listed: boolean }

export type FleetName = "F0" | "F4" | "FREADY" | "F20" | "FLONG" | "FUNKNOWN" | "FLEET50" | "FLEET200" | "FLEET1000";

function f20(): PcSpec[] {
  const names = ["Studio desktop", "Work laptop", "Home server", "Build box", "Render node", "Media PC", "Lab NUC", "Office iMac", "Garage Pi", "Test rig A",
    "Test rig B", "CI runner 1", "CI runner 2", "Backup NAS", "Game PC", "Kids laptop", "Travel laptop", "Old MacBook", "Kitchen tablet PC", "Spare desktop"];
  return names.map((label, i) => ({
    label, relay: i % 3 === 0 ? AP_RELAY : GLOBAL_RELAY, paired: i < 12, listed: true,
    seenAgo: i < 8 || (i >= 12 && i < 16) ? MIN : i < 12 ? (2 + (i - 8)) * DAY : null,
    addedAgo: (10 + i) * DAY,
  }));
}

function fleet(n: number): PcSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const kind = i < 8 ? "ready" : (["join", "offline", "never", "join", "offline"] as const)[i % 5] ?? "join";
    return {
      label: `${["Build", "Render", "Lab", "Test rig", "CI runner", "Studio", "Media", "Backup"][i % 8] ?? "PC"} ${String(i + 1).padStart(4, "0")}`,
      relay: i % 5 === 0 ? AP_RELAY : GLOBAL_RELAY, paired: kind === "ready", listed: true,
      seenAgo: kind === "ready" || kind === "join" ? MIN : kind === "offline" ? (1 + (i % 6)) * DAY : null,
      addedAgo: (10 + (i % 300)) * DAY,
    };
  });
}

export const LONG_NAME = "Workstation on the third floor lab bench with a very long name";

export const FLEETS: Readonly<Record<FleetName, readonly PcSpec[]>> = {
  F0: [],
  F4: [
    { label: "Studio desktop", relay: GLOBAL_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: false, listed: true },
    { label: "Work laptop", relay: AP_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: false, listed: true },
    { label: "Home server", relay: GLOBAL_RELAY, seenAgo: 3 * DAY, addedAgo: 7 * DAY, paired: false, listed: true },
    { label: "Old MacBook", relay: AP_RELAY, seenAgo: null, addedAgo: 7 * DAY, paired: false, listed: true },
  ],
  FREADY: [
    { label: "Studio desktop", relay: GLOBAL_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: true, listed: true },
    { label: "Work laptop", relay: AP_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: true, listed: true },
    { label: "Home server", relay: GLOBAL_RELAY, seenAgo: 3 * DAY, addedAgo: 7 * DAY, paired: true, listed: true },
    { label: "Lab NUC", relay: GLOBAL_RELAY, seenAgo: null, addedAgo: 7 * DAY, paired: true, listed: false },
    { label: "New mini PC", relay: GLOBAL_RELAY, seenAgo: null, addedAgo: 2 * MIN, paired: false, listed: true },
    { label: "Old MacBook", relay: AP_RELAY, seenAgo: null, addedAgo: 7 * DAY, paired: false, listed: true },
  ],
  F20: f20(),
  FLONG: [
    { label: LONG_NAME, relay: GLOBAL_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: true, listed: true },
    { label: "Render node in the basement rack that nobody remembers naming", relay: AP_RELAY, seenAgo: null, addedAgo: 7 * DAY, paired: false, listed: true },
  ],
  FUNKNOWN: [
    { label: "Spare desktop", relay: GLOBAL_RELAY, seenAgo: null, addedAgo: 7 * DAY, paired: true, listed: true },
    { label: "Studio desktop", relay: GLOBAL_RELAY, seenAgo: MIN, addedAgo: 7 * DAY, paired: true, listed: true },
  ],
  FLEET50: fleet(50),
  FLEET200: fleet(200),
  FLEET1000: fleet(1000),
};

export interface Seed { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string; readonly listed: boolean }
export interface FleetPc extends PcSpec { readonly server_id: string; readonly public_key_hex: string; readonly server_public_key: string }
export interface Fleet { readonly name: FleetName; readonly pcs: readonly FleetPc[]; readonly seeds: readonly Seed[] }

const made = new Map<FleetName, Fleet>();
export function fleetOf(name: FleetName): Fleet {
  const known = made.get(name);
  if (known) return known;
  const pcs = FLEETS[name].map((spec): FleetPc => {
    const { publicKey } = generateKeyPair();
    return { ...spec, server_id: deriveServerId(publicKey), public_key_hex: Buffer.from(publicKey).toString("hex"), server_public_key: exportPublicKey(publicKey) };
  });
  const seeds = pcs.filter((pc) => pc.paired).map((pc) => ({ server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.label, listed: pc.listed }));
  const fleet = { name, pcs, seeds };
  made.set(name, fleet);
  return fleet;
}

export function directoryOf(fleet: Fleet, now: number): FakePc[] {
  return fleet.pcs.filter((pc) => pc.listed).map((pc) => ({
    server_id: pc.server_id, label: pc.label, public_key: pc.public_key_hex, relay: pc.relay,
    added_at: new Date(now - pc.addedAgo).toISOString(),
    last_seen_at: pc.seenAgo === null ? null : new Date(now - pc.seenAgo).toISOString(),
  }));
}

/**
 * Signed in (`account`), under the account's own key, the listed ones linked to the account; signed out, under a
 * fresh non-extractable key of their own.
 */
export async function seedPairings(page: Page, seeds: readonly Seed[], account: string | null): Promise<void> {
  await page.evaluate(async ({ seeds, account }) => {
    const open = (name: string, version: number, upgrade: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let key: { private_key: CryptoKey; public_spki: string } | undefined;
    if (account !== null) {
      const db = await open("ovis-account", 1, (d) => d.createObjectStore("account"));
      key = await new Promise<{ private_key: CryptoKey; public_spki: string } | undefined>((resolve, reject) => {
        const request = db.transaction("account", "readonly").objectStore("account").get("key");
        request.onsuccess = () => resolve(request.result as { private_key: CryptoKey; public_spki: string } | undefined);
        request.onerror = () => reject(request.error);
      });
      db.close();
    } else {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
      key = { private_key: pair.privateKey, public_spki: btoa(String.fromCharCode(...spki)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
    }
    if (key === undefined) throw new Error("no account key after the sign-in");
    const held = key;
    const db = await open("ovis-relay", 2, (d) => {
      if (!d.objectStoreNames.contains("devices")) d.createObjectStore("devices", { keyPath: "server_id" });
      if (!d.objectStoreNames.contains("pending-push")) d.createObjectStore("pending-push", { keyPath: "server_id" });
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite");
      for (const seed of seeds) {
        tx.objectStore("devices").put({
          server_id: seed.server_id, device_id: `dev_${seed.server_id.slice(0, 12)}`, private_key: held.private_key, public_spki: held.public_spki,
          label: "Chrome on Linux", server_public_key: seed.server_public_key, relay: seed.relay, name: seed.name,
          ...(account !== null && seed.listed ? { account } : {}),
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { seeds, account });
}
