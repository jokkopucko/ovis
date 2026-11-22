/**
 * The fingerprint both pairing surfaces show (device-row-states rows T71, T72, Q20, P22): SHA-256 over the proved key,
 * this PC's relay identity and a challenge the PC made after the key was named, so no key can be searched to show a
 * chosen one, on this PC or another.
 */
import { expect, test } from "bun:test";
import { exportAccountKey } from "./account-records.ts";
import { pairChallenge, pairFingerprint, pairProofBytes, PAIR_FINGERPRINT_PATTERN, signPairProof, verifyPairProof } from "./pair-fingerprint.ts";

async function device() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}
const SERVER = "0123456789abcdef0123456789abcdef";
const OTHER_SERVER = "fedcba9876543210fedcba9876543210";

test("T71: the fingerprint is eight Crockford characters, the same on both ends for one key, PC and challenge", async () => {
  const { spki } = await device();
  const challenge = pairChallenge();
  const shown = await pairFingerprint(SERVER, challenge, spki);
  expect(shown).toMatch(PAIR_FINGERPRINT_PATTERN);
  expect(await pairFingerprint(SERVER, challenge, spki)).toBe(shown);
});

test("T71: another challenge, another PC or another key gives another fingerprint", async () => {
  const { spki } = await device();
  const other = await device();
  const challenge = pairChallenge();
  const shown = await pairFingerprint(SERVER, challenge, spki);
  expect(await pairFingerprint(SERVER, pairChallenge(), spki)).not.toBe(shown);
  expect(await pairFingerprint(OTHER_SERVER, challenge, spki)).not.toBe(shown);
  expect(await pairFingerprint(SERVER, challenge, other.spki)).not.toBe(shown);
});

test("T71: every field is length-framed, so moving bytes between fields changes the fingerprint and the proof", async () => {
  const challenge = pairChallenge();
  const shifted = await pairFingerprint(SERVER.slice(0, -1), SERVER.slice(-1) + challenge, "key");
  expect(await pairFingerprint(SERVER, challenge, "key")).not.toBe(shifted);
  expect(pairProofBytes(SERVER, challenge, "key")).not.toEqual(pairProofBytes(SERVER.slice(0, -1), SERVER.slice(-1) + challenge, "key"));
});

test("T72: the proof holds only for the key that signed this PC's challenge", async () => {
  const phone = await device();
  const stranger = await device();
  const challenge = pairChallenge();
  const proof = await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey);
  expect(await verifyPairProof(SERVER, challenge, phone.spki, proof)).toBe(true);
  expect(await verifyPairProof(SERVER, pairChallenge(), phone.spki, proof)).toBe(false);
  expect(await verifyPairProof(OTHER_SERVER, challenge, phone.spki, proof)).toBe(false);
  expect(await verifyPairProof(SERVER, challenge, stranger.spki, proof)).toBe(false);
  expect(await verifyPairProof(SERVER, challenge, phone.spki, "not-a-signature")).toBe(false);
});

test("T71: a challenge is 32 fresh random bytes, base64url", () => {
  const first = pairChallenge();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pairChallenge()).not.toBe(first);
});
