import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";

import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { CompactRelay, RelayPairing } from "./RelayPanel.tsx";

const SERVER_ID = "c".repeat(32);
const OFFER_ID = "a".repeat(32);

describe("the compact pairing window", () => {
  let page: Page;
  let fetch: ReturnType<typeof spyOn> | undefined;
  const events = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    page = openPage();
    // the pairing window announces codes with window.dispatchEvent(new CustomEvent(...)): the page's own event classes
    for (const [key, value] of Object.entries({ Event: page.window.Event, CustomEvent: page.window.CustomEvent })) {
      events.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ code: "AB3DE7FGH", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: SERVER_ID }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    fetch?.mockRestore();
    await page.close();
    for (const [key, descriptor] of events) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    events.clear();
  });

  const keyIds = () => [...page.container.querySelectorAll('span.key-id[role="group"]')]
    .map((node) => [[...node.querySelectorAll(".key-id-group")].map((group) => group.textContent).join(""), node.getAttribute("aria-label")]);

  it("shows this PC's ID under the code, for the phone's comparison", async () => {
    await page.render(createElement(SettingsProvider, null, createElement(CompactRelay, { qr: null, qrExpires: null, failure: null, reset: 0, onMinted: () => {} })));

    expect(keyIds()).toEqual([[SERVER_ID, "This PC's ID"]]);
    const window = page.one('[class="relay-pairing-compact"]');
    const codeAndId = [...window.querySelectorAll('p[class="compact-pair-code"], span[class="key-id-group"]')];
    expect(codeAndId.map((node) => node.textContent)).toEqual(["AB3DE7FGH", ...Array<string>(8).fill("cccc")]);
    expect(page.one('[class="relay-pairing-id"]').querySelector("p")!.textContent).toBe("This PC's ID");
  });

  it("shows the QR offer's ID while no code could be had", async () => {
    fetch?.mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: globalThis.fetch.preconnect }));
    const qr = encodeOffer({ v: 1, server_id: OFFER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.example", code: "482913", name: "Workstation" }, "https://app.ovis.example");
    await page.render(createElement(SettingsProvider, null, createElement(CompactRelay, { qr, qrExpires: null, failure: null, reset: 0, onMinted: () => {} })));

    expect(keyIds().map(([id]) => id)).toEqual([OFFER_ID]);
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
    await page.render(createElement(SettingsProvider, null, createElement(RelayPairing, { compact: true })));
    const displayedId = () => keyIds().map(([id]) => id);
    expect(displayedId()).toEqual([OFFER_ID]);
    const refresh = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh"));
    if (refresh === undefined) throw new Error("Refresh button did not render");

    resetIdentity = true;
    try {
      await act(async () => { refresh.click(); });
      expect([...page.container.querySelectorAll('[class="compact-pair-code"]')].map((node) => node.textContent)).toEqual(["JK4MN8PQR"]);
      expect(displayedId()).toEqual([SERVER_ID]);
    } finally {
      await act(async () => { replacement.resolve(offer(SERVER_ID)); });
    }
  });
});
