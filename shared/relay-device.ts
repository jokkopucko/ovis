/**
 * A relay device's key for one PC, as the hosted app keeps it (src/lib/relay/device.ts, IndexedDB) and as a PC's
 * server keeps one for a PC it added through the relay (server/relay-pc.ts, a private file): signing in and pinning.
 */
import type { RelayOffer } from "./relay-offer.ts";

export class ServerIdentityChangedError extends Error {
  readonly code = "server_identity_changed";
  /** `saved` and `offered`: the two keys that disagree, one of which is not the key `serverId` names */
  constructor(readonly serverId: string, readonly saved?: string, readonly offered?: string) {
    super("This PC's identity changed");
    this.name = "ServerIdentityChangedError";
  }
}

export interface RelayDevice {
  readonly server_id: string;
  readonly device_id: string | null;
  readonly private_key: CryptoKey;
  readonly public_spki: string;
  readonly label: string;
  readonly server_public_key: string;
  readonly relay: string;
  readonly name?: string;
}

/** Updates are atomic, including between two tabs the same PC admits at once. */
export interface RelayDeviceStore {
  get(serverId: string): Promise<RelayDevice | undefined>;
  update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice>;
  /** Every saved PC, in the order they were first saved. */
  list(): Promise<RelayDevice[]>;
  /** Forgets a PC: its key is gone for good, and the PC's next pairing makes a new one; a push subscription kept for it goes too. */
  remove(serverId: string): Promise<void>;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkPin(device: RelayDevice, offer: RelayOffer): RelayDevice {
  if (device.server_public_key !== offer.server_public_key) throw new ServerIdentityChangedError(offer.server_id, device.server_public_key, offer.server_public_key);
  return device;
}

/**
 * The saved key for the offer's PC, or a new one that is not saved yet: a new key is kept only once
 * the PC admits it (channel.ts), so a link whose PC never does takes no PC's slot.
 */
export async function getDevice(offer: RelayOffer, store: RelayDeviceStore, label = "Device"): Promise<RelayDevice> {
  const stored = await store.get(offer.server_id);
  if (stored) return checkPin(stored, offer);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
    ...(offer.name === undefined ? {} : { name: offer.name }),
    device_id: null, private_key: keys.privateKey,
    public_spki: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))), label,
  };
}

/** Raw r||s ECDSA signature; the server verifies this exact domain, nonce and server id. */
export async function sign(device: RelayDevice, nonce: Uint8Array, serverId: string): Promise<string> {
  if (nonce.length !== 32 || serverId !== device.server_id) throw new TypeError("Invalid relay authentication challenge");
  const encoder = new TextEncoder();
  const domain = encoder.encode("ovis-relay-auth/1");
  const id = encoder.encode(serverId);
  const message = new Uint8Array(domain.length + nonce.length + id.length);
  message.set(domain);
  message.set(nonce, domain.length);
  message.set(id, domain.length + nonce.length);
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.private_key, message)));
}
