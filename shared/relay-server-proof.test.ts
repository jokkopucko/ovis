import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { answerServerChallenge, deriveServerId, serverChallenge, verifyServerProof, type ProofRoute } from "./relay-server-proof.ts";

// RFC 7748 section 6.1's key pairs: the PC's key, and a relay's ephemeral one. The answer is the one
// tweetnacl gave, so a PC and a relay on either side of the move to @noble still agree byte for byte.
const PC_SECRET = hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const PC_PUBLIC = hexToBytes("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const RELAY_PUBLIC = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const SERVER_ID = "13b4d3cd80478aee7464bbce23620d33";
const ROUTE: ProofRoute = { server_id: SERVER_ID, role: "data", connection_id: "c1" };
const CHALLENGE = JSON.stringify({ type: "server_challenge", public_key: RELAY_PUBLIC, nonce: "00".repeat(16) + "ff".repeat(16) });
const ANSWER = "7815327bf8e7519097b740be0a1a3e8af10736d77bd9fc7c53e0381d2882e787";

// u = 0 and u = 1: points of small order, whose shared secret proves nothing
const LOW_ORDER = ["00".repeat(32), "01" + "00".repeat(31)];

describe("server proof bytes", () => {
  test("a saved key keeps its server_id, and the PC's answer to a fixed challenge stays the same bytes", () => {
    expect(deriveServerId(PC_PUBLIC)).toBe(SERVER_ID);
    expect(answerServerChallenge(CHALLENGE, PC_SECRET, ROUTE)).toBe(JSON.stringify({ type: "server_proof", answer: ANSWER }));
  });

  test("a relay key with its top bit set is read as tweetnacl read it, with the bit masked", () => {
    const highBit = CHALLENGE.replace(RELAY_PUBLIC, RELAY_PUBLIC.slice(0, 62) + "cf");
    expect(answerServerChallenge(highBit, PC_SECRET, ROUTE)).toBe(JSON.stringify({ type: "server_proof", answer: ANSWER }));
  });

  test("the relay's challenge is answered only by the key it was made for", () => {
    const { expected, frame } = serverChallenge(PC_PUBLIC, ROUTE);
    expect(verifyServerProof(answerServerChallenge(frame, PC_SECRET, ROUTE), expected)).toBe(true);
    expect(verifyServerProof(answerServerChallenge(frame, PC_SECRET, { ...ROUTE, connection_id: "c2" }), expected)).toBe(false);
    const other = PC_SECRET.slice();
    other[0]! ^= 0x40;
    expect(verifyServerProof(answerServerChallenge(frame, other, ROUTE), expected)).toBe(false);
  });

  test.each(LOW_ORDER)("a low-order key %s is refused on both sides", (key) => {
    expect(() => serverChallenge(hexToBytes(key), ROUTE)).toThrow("invalid proof public key");
    const frame = JSON.stringify({ type: "server_challenge", public_key: key, nonce: bytesToHex(new Uint8Array(32)) });
    expect(answerServerChallenge(frame, PC_SECRET, ROUTE)).toBeNull();
  });
});
