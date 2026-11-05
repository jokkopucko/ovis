// The app's connect screen (app/web/shell.js): which typed or scanned addresses open a PC through
// the Ovis relay, with offers made the way a PC makes them (shared/relay-offer.ts).
import { describe, expect, it } from "bun:test";
// @ts-expect-error app/web is plain JavaScript the app carries as is, without types
import { APP_ORIGIN, parseAddress, relayLink } from "../app/web/shell.js";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const offer = { v: 1 as const, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.sh", code: "123456", name: "Studio PC" };
const link = (text: string, appOrigin?: string) => relayLink(parseAddress(text), appOrigin);

describe("relay pairing links", () => {
  it("opens an offer on the app's origin at its scope, the fragment kept, labelled from the offer", () => {
    const url = encodeOffer(offer, APP_ORIGIN);
    expect(APP_ORIGIN).toBe("https://app.ovis.sh");
    expect(link(url)).toEqual({ url, scope: `https://app.ovis.sh/s/${SERVER_ID}/`, name: "Studio PC" });
  });

  it("takes the configured app origin, and an offer without a name or a scope without its slash", () => {
    const origin = "https://shell.example.ts.net:18921";
    const { name: _, ...unnamed } = offer;
    const url = encodeOffer(unnamed, origin);
    const fragment = url.slice(url.indexOf("#"));
    expect(link(url, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(`${origin}/s/${SERVER_ID}${fragment}`, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(url)).toEqual({ error: "foreign-offer" });
  });

  it("reopens a saved relay PC by its scope", () => {
    const scope = `https://app.ovis.sh/s/${SERVER_ID}/`;
    expect(link(scope)).toEqual({ url: scope, scope, name: undefined });
  });

  it("refuses an offer on any other origin", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    for (const text of [
      `https://evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#${fragment}`,
      `http://app.ovis.sh/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh.evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh:8443/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#offer=`,
    ]) expect([text, link(text)]).toEqual([text, { error: "foreign-offer" }]);
  });

  it("refuses an offer that is malformed or names another PC, and the app's other pages", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    const other = "fedcba9876543210fedcba9876543210";
    const json = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const text of [
      `https://app.ovis.sh/s/${other}/#${fragment}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=not*base64`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json([1])}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, v: 2 })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, name: "x".repeat(65) })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${"A".repeat(2049)}`,
    ]) expect([text, link(text)]).toEqual([text, { error: "bad-offer" }]);
    for (const text of ["https://app.ovis.sh/", `https://app.ovis.sh/s/${SERVER_ID.toUpperCase()}/`, `https://app.ovis.sh/s/${SERVER_ID}/sw.js`, `https://app.ovis.sh/s/${SERVER_ID}/#pair`]) {
      expect([text, link(text)]).toEqual([text, { error: "not-a-pc" }]);
    }
  });

  it("leaves a PC's own address to open as before", () => {
    for (const text of ["https://pc.tail1234.ts.net", "100.64.0.1:7421/?pair=123456", "https://pc.example.com/#settings"]) {
      expect([text, link(text)]).toEqual([text, null]);
    }
  });
});
