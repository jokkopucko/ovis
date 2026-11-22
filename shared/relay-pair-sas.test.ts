import { expect, test } from "bun:test";
import { decodeFrame, encodeFrame, FrameType, MuxProtocolError } from "./relay-mux.ts";
import { commitmentHolds, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "./relay-pair-sas.ts";

const key = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(86);

test("the digits are six, and change with the channel, the device key and either nonce", () => {
  const binding = randomPairNonce();
  const phone = randomPairNonce();
  const pc = randomPairNonce();
  const digits = pairDigits(binding, key, phone, pc);
  expect(digits).toMatch(/^[0-9]{6}$/);
  expect(pairDigits(binding, key, phone, pc)).toBe(digits);
  const others = [pairDigits(randomPairNonce(), key, phone, pc), pairDigits(binding, key.slice(0, -1) + "B", phone, pc),
    pairDigits(binding, key, randomPairNonce(), pc), pairDigits(binding, key, phone, randomPairNonce())];
  expect(others.filter((other) => other === digits).length).toBeLessThan(2);
});

test("a commitment holds only for its nonce, channel and device key", () => {
  const binding = randomPairNonce();
  const nonce = randomPairNonce();
  const commitment = pairCommitment(binding, key, nonce);
  expect(commitmentHolds(commitment, binding, key, nonce)).toBe(true);
  expect(commitmentHolds(commitment, binding, key, randomPairNonce())).toBe(false);
  expect(commitmentHolds(commitment, randomPairNonce(), key, nonce)).toBe(false);
  expect(commitmentHolds(commitment, binding, key.slice(0, -1) + "B", nonce)).toBe(false);
  expect(commitmentHolds(commitment.subarray(0, 31), binding, key, nonce)).toBe(false);
});

test("the pairing frames round-trip on stream zero, and malformed ones are refused", () => {
  const frames = [
    { type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Phone", public_key: key, commitment: toBase64Url(randomPairNonce()) } },
    { type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(randomPairNonce()) } },
    { type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(randomPairNonce()) } },
    { type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } },
  ] as const;
  for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  const raw = (type: number, payload: unknown, stream = 0) => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(8 + body.length);
    bytes[0] = 1; bytes[1] = type; new DataView(bytes.buffer).setUint32(4, stream); bytes.set(body, 8);
    return bytes;
  };
  for (const bad of [
    raw(FrameType.PAIR_CONFIRM, { confirmed: false }),
    raw(FrameType.PAIR_CONFIRM, { confirmed: true, extra: 1 }),
    raw(FrameType.PAIR_CHALLENGE, { nonce: "short" }),
    raw(FrameType.PAIR_REVEAL, { nonce: toBase64Url(randomPairNonce()) }, 1),
    raw(FrameType.PAIR_REQUEST, { label: "Phone", public_key: "x".repeat(91), commitment: toBase64Url(randomPairNonce()) }),
  ]) expect(() => decodeFrame(bad)).toThrow(MuxProtocolError);
});
