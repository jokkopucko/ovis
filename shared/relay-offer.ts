/**
 * The pairing offer a server shows to a phone: which server it is, the public key to pin, and the
 * relay to reach it through. It travels in the URL fragment (`${appBase}/s/${server_id}/#offer=<base64url JSON>`),
 * which a browser never sends to any server. The path carries the server_id too, so one origin can
 * hold a PWA scope per PC; decodeOffer refuses a URL whose path and payload name different servers.
 * The browser imports this file, so it reads no environment.
 */
import { importPublicKey } from "./relay-e2ee.ts";
import { SERVER_ID_PATTERN } from "./relay-id.ts";

export { SERVER_ID_PATTERN };

export interface RelayOffer {
  v: 1;
  /** 32 lowercase hex characters */
  server_id: string;
  /** the server's X25519 public key, as the vendored key helpers encode it */
  server_public_key: string;
  /** the relay's wss origin, no path */
  relay: string;
  /** one-time pairing code, 6 digits */
  code?: string;
  /** a label for the PC, at most 64 characters */
  name?: string;
}

const MAX_PAYLOAD_CHARS = 2048;
const MAX_NAME_CHARS = 64;
const MAX_RELAY_CHARS = 255;
const OFFER_PREFIX = "#offer=";

export function encodeOffer(offer: RelayOffer, appBase: string): string {
  const checked = validateOffer(offer);
  const base = appBase.replace(/\/+$/, "");
  return `${base}/s/${checked.server_id}/${OFFER_PREFIX}${toBase64Url(JSON.stringify(checked))}`;
}

/** The offer in `url`'s fragment; null when there is none. Throws on anything malformed. */
export function decodeOffer(url: string): RelayOffer | null {
  const parsed = new URL(url);
  if (!parsed.hash.startsWith(OFFER_PREFIX)) return null;
  const payload = parsed.hash.slice(OFFER_PREFIX.length);
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) throw new Error("Invalid offer payload length");
  let value: unknown;
  try { value = JSON.parse(fromBase64Url(payload)); }
  catch { throw new Error("Invalid offer payload encoding"); }
  const offer = validateOffer(value);
  const pathId = /\/s\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  if (pathId !== offer.server_id) throw new Error("Offer server_id does not match the URL path");
  return offer;
}

export function validateOffer(value: unknown): RelayOffer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid offer");
  const o = value as Record<string, unknown>;
  if (o.v !== 1) throw new Error("Unsupported offer version");
  if (typeof o.server_id !== "string" || !SERVER_ID_PATTERN.test(o.server_id)) throw new Error("Invalid offer server_id");
  if (typeof o.server_public_key !== "string") throw new Error("Invalid offer server_public_key");
  try { importPublicKey(o.server_public_key); } catch { throw new Error("Invalid offer server_public_key"); }
  if (typeof o.relay !== "string" || !isWssOrigin(o.relay)) throw new Error("Invalid offer relay");
  if (o.code !== undefined && (typeof o.code !== "string" || !/^\d{6}$/.test(o.code))) throw new Error("Invalid offer code");
  if (o.name !== undefined && (typeof o.name !== "string" || o.name.length > MAX_NAME_CHARS)) throw new Error("Invalid offer name");
  const offer: RelayOffer = { v: 1, server_id: o.server_id, server_public_key: o.server_public_key, relay: o.relay };
  if (o.code !== undefined) offer.code = o.code as string;
  if (o.name !== undefined) offer.name = o.name as string;
  return offer;
}

export function isWssOrigin(text: string): boolean {
  if (text.length > MAX_RELAY_CHARS) return false;
  try {
    const url = new URL(text);
    return url.protocol === "wss:" && url.origin === text;
  } catch { return false; }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("bad base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
