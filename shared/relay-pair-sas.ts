/**
 * Pairing by comparing six digits (docs/relay.md, "Pairing by comparing digits"): for a phone that
 * has the PC's public key from somewhere it cannot fully trust, such as a link without a code.
 * Commit, then reveal, as Bluetooth's numeric comparison does:
 *
 *   phone -> PC  PAIR_REQUEST  commitment = H(commit domain || binding || device key || Np)
 *   PC -> phone  PAIR_CHALLENGE  Nc
 *   phone -> PC  PAIR_REVEAL   Np; the PC checks it against the commitment
 *   both show    digits = H(digits domain || binding || device key || Np || Nc) mod 10^6
 *
 * `binding` is the channel binding of the Noise handshake under them (shared/relay-e2ee.ts
 * channelBinding): a relay that answers the phone with its own key runs two handshakes, so the two
 * ends hold different bindings. Neither end chooses the digits: the phone is held to Np before it
 * sees Nc, and the PC picks Nc before it sees Np, so a relay in the middle gets matching digits on
 * the two screens once in a million tries.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** How long both people have, from PAIR_REQUEST, to compare the digits and approve; under the relay's 120 s idle close (relay/core.ts IDLE_MS). */
export const PAIR_APPROVAL_MS = 90_000;
export const PAIR_NONCE_BYTES = 32;

const COMMIT_DOMAIN = utf8ToBytes("ovis-relay-pair-commit/1");
const DIGITS_DOMAIN = utf8ToBytes("ovis-relay-pair-digits/1");

export function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkInputs(binding: Uint8Array, nonces: readonly Uint8Array[]): void {
  if (binding.length !== 32 || nonces.some((nonce) => nonce.length !== PAIR_NONCE_BYTES)) throw new TypeError("Invalid pairing input");
}

/** The phone's commitment to `phoneNonce`, for this channel and this device key (P-256 SPKI, base64url). */
export function pairCommitment(binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array): Uint8Array {
  checkInputs(binding, [phoneNonce]);
  return sha256(concatBytes(COMMIT_DOMAIN, binding, utf8ToBytes(devicePublicKey), phoneNonce));
}

/** Whether a revealed nonce is the one committed to; compared in constant time. */
export function commitmentHolds(commitment: Uint8Array, binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array): boolean {
  if (commitment.length !== 32) return false;
  const expected = pairCommitment(binding, devicePublicKey, phoneNonce);
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= (expected[index] ?? 0) ^ (commitment[index] ?? 0);
  return difference === 0;
}

/** The six digits both screens show, as a string of exactly six; the 64-bit reduction's bias is under 10^-13. */
export function pairDigits(binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array, pcNonce: Uint8Array): string {
  checkInputs(binding, [phoneNonce, pcNonce]);
  const digest = sha256(concatBytes(DIGITS_DOMAIN, binding, utf8ToBytes(devicePublicKey), phoneNonce, pcNonce));
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
  return String(value % 1_000_000n).padStart(6, "0");
}

export function randomPairNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PAIR_NONCE_BYTES));
}
