import { describe, expect, it } from "bun:test";
import { exportPublicKey, generateKeyPair } from "./relay-e2ee.ts";
import { decodeOffer, encodeOffer, type RelayOffer } from "./relay-offer.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const APP = "https://ovis.example.ts.net";

const offer = (extra: Partial<RelayOffer> = {}): RelayOffer => ({
  v: 1, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example.com", ...extra,
});

const b64url = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const urlWith = (payload: string, id = SERVER_ID): string => `${APP}/s/${id}/#offer=${payload}`;

describe("relay offer", () => {
  it("round-trips through a per-PC URL", () => {
    const full = offer({ code: "012345", name: "Home PC é" });
    const url = encodeOffer(full, `${APP}/`);
    expect(url.startsWith(`${APP}/s/${SERVER_ID}/#offer=`)).toBe(true);
    expect(decodeOffer(url)).toEqual(full);
    const bare = offer();
    expect(decodeOffer(encodeOffer(bare, APP))).toEqual(bare);
  });

  it("returns null without an offer fragment", () => {
    expect(decodeOffer(`${APP}/s/${SERVER_ID}/`)).toBeNull();
    expect(decodeOffer(`${APP}/s/${SERVER_ID}/#other=1`)).toBeNull();
  });

  it("throws on a malformed payload", () => {
    for (const payload of ["", "!!!", "a", b64url("not json"), b64url("[]"), b64url("null")]) {
      expect(() => decodeOffer(urlWith(payload))).toThrow();
    }
  });

  it("throws on bad field types and values", () => {
    const good = offer();
    const bad: unknown[] = [
      { ...good, v: 2 }, { ...good, server_id: "ABC" }, { ...good, server_id: 5 },
      { ...good, server_public_key: "AAAA" }, { ...good, server_public_key: 7 },
      { ...good, relay: "ws://relay.example.com" }, { ...good, relay: "wss://relay.example.com/path" }, { ...good, relay: "nope" },
      { ...good, code: "12345" }, { ...good, code: 123456 }, { ...good, name: 1 },
    ];
    for (const value of bad) expect(() => decodeOffer(urlWith(b64url(value)))).toThrow();
  });

  it("throws on over-long values", () => {
    expect(() => decodeOffer(urlWith(b64url(offer({ name: "x".repeat(65) }))))).toThrow();
    expect(() => decodeOffer(urlWith("A".repeat(5000)))).toThrow();
    expect(() => encodeOffer(offer({ name: "x".repeat(65) }), APP)).toThrow();
  });

  it("throws when the path server_id differs from the payload's", () => {
    const payload = b64url(offer());
    expect(() => decodeOffer(urlWith(payload, OTHER_ID))).toThrow();
    expect(() => decodeOffer(`${APP}/#offer=${payload}`)).toThrow();
    expect(decodeOffer(urlWith(payload))?.server_id).toBe(SERVER_ID);
  });
});
