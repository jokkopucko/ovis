import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { KeyId } from "./KeyId.tsx";
import { CompactRelay, RelayPairing } from "./RelayPanel.tsx";

const SERVER_ID = "c".repeat(32);
const OFFER_ID = "a".repeat(32);

describe("the compact pairing window", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fetch: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setTimeout, clearTimeout, setInterval, clearInterval });
    define("document", { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ code: "AB3DE7FGH", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: SERVER_ID }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    fetch?.mockRestore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("shows this PC's ID under the code, for the phone's comparison", async () => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(CompactRelay, { qr: null, qrExpires: null, failure: null, reset: 0, onMinted: () => {} })));
    });

    expect(renderer!.root.findAllByType(KeyId).map((node) => [node.props.id, node.props.label])).toEqual([[SERVER_ID, "This PC's ID"]]);
    const window = renderer!.root.findByProps({ className: "relay-pairing-compact" });
    const codeAndId = window.findAll((node) =>
      (node.type === "p" && node.props.className === "compact-pair-code") ||
      (node.type === "span" && node.props.className === "key-id-group"));
    expect(codeAndId.flatMap((node) => node.children)).toEqual(["AB3DE7FGH", ...Array<string>(8).fill("cccc")]);
    expect(renderer!.root.findByProps({ className: "relay-pairing-id" }).findByType("p").children).toEqual(["This PC's ID"]);
  });

  it("shows the QR offer's ID while no code could be had", async () => {
    fetch?.mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: globalThis.fetch.preconnect }));
    const qr = encodeOffer({ v: 1, server_id: OFFER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.example", code: "482913", name: "Workstation" }, "https://app.ovis.example");
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(CompactRelay, { qr, qrExpires: null, failure: null, reset: 0, onMinted: () => {} })));
    });

    expect(renderer!.root.findAllByType(KeyId).map((node) => node.props.id)).toEqual([OFFER_ID]);
  });

  it("shows the refreshed typed code's ID while the replacement QR offer is pending", async () => {
    const expires_at = new Date(Date.now() + 600_000).toISOString();
    const offer = (server_id: string) => Response.json({
      url: encodeOffer({ v: 1, server_id, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.example", code: "482913", name: "Workstation" }, "https://app.ovis.example"),
      expires_at,
    });
    const replacement = Promise.withResolvers<Response>();
    let resetIdentity = false;
    fetch?.mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (input === "/api/relay/offer") return resetIdentity ? replacement.promise : offer(OFFER_ID);
      return Response.json({
        code: resetIdentity ? "JK4MN8PQR" : "AB3DE7FGH",
        server_id: resetIdentity ? SERVER_ID : OFFER_ID,
        expires_at,
      });
    }, { preconnect: globalThis.fetch.preconnect }));
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(RelayPairing, { compact: true })));
    });
    if (renderer === undefined) throw new Error("Pairing window did not render");
    const root = renderer.root;
    const displayedId = () => root.findAllByType(KeyId).map((node) => node.props.id);
    expect(displayedId()).toEqual([OFFER_ID]);
    const refresh = root.findAllByType("button").find((button) => button.children.includes("Refresh"));
    if (refresh === undefined) throw new Error("Refresh button did not render");

    resetIdentity = true;
    try {
      await act(async () => { refresh.props.onClick(); });
      expect(root.findByProps({ className: "compact-pair-code" }).children).toEqual(["JK4MN8PQR"]);
      expect(displayedId()).toEqual([SERVER_ID]);
    } finally {
      await act(async () => { replacement.resolve(offer(SERVER_ID)); });
    }
  });
});
