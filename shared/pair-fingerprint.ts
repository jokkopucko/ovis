/**
 * The fingerprint a pairing shows on the device and on the PC's screen, and the proof that the device holds the key it
 * named. Both are taken over this PC's relay identity and a challenge the PC makes only after the device named its key,
 * so a key searched for in advance cannot be made to show a chosen fingerprint, here or on another PC. Every field is
 * length-framed behind a domain tag, so bytes cannot move between fields.
 */
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Time the PC allows for on-screen confirmation of a pending key. */
export const PENDING_MS = 5 * 60_000;

const FINGERPRINT_DOMAIN = "ovis-pair-fp/1";
const PROOF_DOMAIN = "ovis-pair-proof/1";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** Eight Crockford base32 characters in two groups of four. */
export const PAIR_FINGERPRINT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function framed(domain: string, fields: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(domain);
  const parts = fields.map((field) => encoder.encode(field));
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/** A fresh challenge: 32 random bytes, base64url. */
export function pairChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What the device signs to prove the key it named: this PC's relay identity, the challenge and the key. */
export function pairProofBytes(serverId: string, challenge: string, key: string): Uint8Array<ArrayBuffer> {
  return framed(PROOF_DOMAIN, [serverId, challenge, key]);
}

/** The first 40 bits of the SHA-256 over this PC's relay identity, the challenge and the key, as `XXXX-XXXX`. */
export async function pairFingerprint(serverId: string, challenge: string, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", framed(FINGERPRINT_DOMAIN, [serverId, challenge, key])));
  let bits = 0n;
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let text = "";
  for (let index = 7; index >= 0; index--) text += CROCKFORD[Number((bits >> BigInt(index * 5)) & 31n)];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

export async function signPairProof(serverId: string, challenge: string, key: string, privateKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, pairProofBytes(serverId, challenge, key))));
}

/** Whether `signature` is `key`'s signature over this PC's challenge; anything malformed is false. */
export async function verifyPairProof(serverId: string, challenge: string, key: string, signature: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key)), P256, false, ["verify"]);
    return await crypto.subtle.verify(SIGN, publicKey, new Uint8Array(fromBase64Url(signature)), pairProofBytes(serverId, challenge, key));
  } catch {
    return false;
  }
}
