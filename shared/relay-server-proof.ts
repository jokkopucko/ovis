/** Relay admission only. These keys and MACs never enter the phone's Noise channel. */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";

export const SERVER_PROOF_CLOSE = 4401;
export const SERVER_PROOF_MS = 10_000;
export const SERVER_PROOF_REQUIRED = "server proof v1 required; update Ovis on the PC";
/** The only 4401 reasons that refuse the PC's key itself; a PC stops retrying on these and on no other 4401. */
export const SERVER_KEY_MISMATCH = "server key does not match server_id";
export const SERVER_KEY_INVALID = "invalid server key";
export const PERMANENT_SERVER_PROOF_REFUSALS: readonly string[] = [SERVER_KEY_MISMATCH, SERVER_KEY_INVALID];

export interface ProofRoute {
  readonly server_id: string;
  readonly role: "control" | "data" | "client";
  readonly connection_id: string | null;
}

/** Self-certifying routing name: no registration database or trust-on-first-use race. */
export function deriveServerId(publicKey: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes("ovis-relay-server-id-v1"), publicKey))).slice(0, 32);
}

export function proofKey(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(text)) return null;
  return hexToBytes(text);
}

function mac(secret: Uint8Array, publicKey: Uint8Array, nonce: Uint8Array, route: ProofRoute): Uint8Array {
  const dh = nacl.scalarMult(secret, publicKey);
  // Reject low-order points; a public all-zero DH result proves no secret possession.
  if (dh.every((byte) => byte === 0)) throw new Error("invalid proof public key");
  return hmac(sha256, dh, concatBytes(nonce, utf8ToBytes(
    `${route.server_id}\0${route.role}\0${route.connection_id ?? ""}\0ovis-relay-server-proof-v1`,
  )));
}

export function serverChallenge(publicKey: Uint8Array, route: ProofRoute) {
  const ephemeral = nacl.box.keyPair();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  return {
    expected: bytesToHex(mac(ephemeral.secretKey, publicKey, nonce, route)),
    frame: JSON.stringify({ type: "server_challenge", public_key: bytesToHex(ephemeral.publicKey), nonce: bytesToHex(nonce) }),
  };
}

/** Returns null for anything other than a canonical challenge. */
export function answerServerChallenge(frame: unknown, secret: Uint8Array, route: ProofRoute): string | null {
  if (typeof frame !== "string" || frame.length > 512) return null;
  try {
    const value: unknown = JSON.parse(frame);
    if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "server_challenge"
      || !("public_key" in value) || !("nonce" in value)) return null;
    const publicKey = proofKey(value.public_key);
    const nonce = proofKey(value.nonce);
    if (!publicKey || !nonce) return null;
    return JSON.stringify({ type: "server_proof", answer: bytesToHex(mac(secret, publicKey, nonce, route)) });
  } catch { return null; } // Untrusted JSON or a low-order X25519 point.
}

export function verifyServerProof(frame: unknown, expected: string): boolean {
  if (typeof frame !== "string" || frame.length > 256) return false;
  try {
    const value: unknown = JSON.parse(frame);
    if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "server_proof" || !("answer" in value)) return false;
    const answer = proofKey(value.answer);
    return answer !== null && nacl.verify(answer, hexToBytes(expected));
  } catch { return false; } // Malformed proof is a policy close, never a handler exception.
}
