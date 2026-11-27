import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Root } from "react-dom/client";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { ListMismatchError } from "../../../shared/relay-channel.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { loadRelayShell } from "../relay.ts";
import type { RelayShellMount } from "./shell.tsx";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { serverIdOfPath, serverScopePath, shellModeOf, shellServiceWorker } from "../shellMode.ts";
import { bootRelayShell, showStart, takeEntryUrl } from "./boot.ts";
import { RelayAdmissionTimeoutError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import { testOffer } from "./device.test.ts";
import { failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, pairsAgainWithoutKey, shellEntry } from "./shellState.ts";

const APP = "https://app.example";

describe("the shell's entry", () => {
  it("reads the PC from the path and the offer from the fragment", () => {
    const offer = { ...testOffer(), code: "123456", name: "Desk" };
    const entry = shellEntry(encodeOffer(offer, APP));
    expect(entry).toEqual({ serverId: offer.server_id, offer, damaged: false });
  });

  it("is a saved PC's page without a fragment, and the front page at the root", () => {
    expect(shellEntry(`${APP}/s/${"12".repeat(16)}/`)).toEqual({ serverId: "12".repeat(16), offer: null, damaged: false });
    expect(shellEntry(`${APP}/`)).toEqual({ serverId: null, offer: null, damaged: false });
    expect(shellEntry(`${APP}/?pane=abc`)).toEqual({ serverId: null, offer: null, damaged: false });
  });

  it("calls a fragment that does not decode, or names another PC, damaged without throwing", () => {
    expect(shellEntry(`${APP}/s/${"12".repeat(16)}/#offer=abc`)).toEqual({ serverId: "12".repeat(16), offer: null, damaged: true });
    const other = encodeOffer(testOffer(), APP).replace(`/s/${"12".repeat(16)}/`, `/s/${"34".repeat(16)}/`);
    expect(shellEntry(other)).toMatchObject({ serverId: "34".repeat(16), offer: null, damaged: true });
    expect(shellEntry(`${APP}/s/not-an-id/#offer=abc`)).toEqual({ serverId: null, offer: null, damaged: true });
  });

  // the mark of a code its PC pins keeps its one value, and no other
  it("keeps the mark admission: 1 of an offer, and calls any other value of it damaged", () => {
    const offer = { ...testOffer(), code: "123456" };
    expect(shellEntry(encodeOffer({ ...offer, admission: 1 }, APP)).offer?.admission).toBe(1);
    expect(shellEntry(encodeOffer(offer, APP)).offer).not.toHaveProperty("admission");
    // an offer is written by hand here: encodeOffer would refuse these too
    for (const value of [2, true, "1", 0]) {
      const fragment = Buffer.from(JSON.stringify({ ...offer, admission: value })).toString("base64url");
      expect(shellEntry(`${APP}/s/${offer.server_id}/#offer=${fragment}`)).toMatchObject({ offer: null, damaged: true });
    }
  });

  it("calls an offer forged when its key is not the one its PC's id is derived from", () => {
    const own = generateKeyPair().publicKey;
    const genuine = { ...testOffer(), server_id: deriveServerId(own), server_public_key: exportPublicKey(own) };
    // Then only the PC's own key passes; another key under its id, or no key at all, is forged.
    expect(forgedOffer(genuine)).toBe(false);
    expect(forgedOffer({ ...genuine, server_public_key: exportPublicKey(generateKeyPair().publicKey) })).toBe(true);
    expect(forgedOffer({ ...genuine, server_public_key: "not-a-key" })).toBe(true);
  });

  it("names the key that is not the one the id names, and where that key came from", () => {
    const own = generateKeyPair().publicKey;
    const other = generateKeyPair().publicKey;
    const serverId = deriveServerId(own);
    const link = (key: Uint8Array) => ({ key: exportPublicKey(key), from: "link" as const });
    const saved = (key: Uint8Array) => ({ key: exportPublicKey(key), from: "saved" as const });
    expect(keyMismatch(serverId, [link(own)])).toBeNull();
    expect(keyMismatch(serverId, [saved(own), link(other)])).toEqual({ expected: serverId, received: deriveServerId(other), from: "link" });
    expect(keyMismatch(serverId, [saved(other), link(own)])).toEqual({ expected: serverId, received: deriveServerId(other), from: "saved" });
    expect(keyMismatch(serverId, [{ key: "not-a-key", from: "link" }])).toEqual({ expected: serverId, received: null, from: "link" });
  });

  it("rebuilds a saved PC's offer without a code", () => {
    const offer = { ...testOffer(), name: "Desk" };
    const device = { ...offer, device_id: "d1", private_key: {} as CryptoKey, public_spki: "spki", label: "Phone" };
    expect(offerOf(device)).toEqual({ v: 1, server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay, name: "Desk" });
    const { name: _name, ...unnamed } = device;
    expect("name" in offerOf(unnamed)).toBe(false);
  });
});

describe("the screen a failure lands on", () => {
  const paired = { code: false, paired: true };
  const pairing = { code: true, paired: false };
  const mux = (code: ConstructorParameters<typeof MuxProtocolError>[0]) => new MuxProtocolError(code, code);

  it("tells the relay from the PC by who stalled: the relay before assigning, the PC before answering, the PC's admission after", () => {
    expect(failureOf(new RelayUnreachableError(null), paired)).toBe("relay-unreachable");
    expect(failureOf(new RelayUnreachableError(null, true), paired)).toBe("relay-unreachable");
    expect(failureOf(new RelayUnreachableError(1013), pairing)).toBe("relay-unreachable");
    expect(failureOf(new TypeError("Failed to fetch"), paired)).toBe("relay-unreachable");
    expect(failureOf(mux("timeout"), paired)).toBe("pc-offline");
    expect(failureOf(mux("internal_error"), paired)).toBe("pc-offline");
    expect(failureOf(new RelayAdmissionTimeoutError("welcome"), paired)).toBe("pc-unresponsive");
    expect(failureOf(new RelayAdmissionTimeoutError("auth"), pairing)).toBe("pc-unresponsive");
  });

  it("names a used code, a revoked phone and a changed identity", () => {
    expect(failureOf(mux("auth_failed"), pairing)).toBe("code-expired");
    expect(failureOf(mux("auth_failed"), { code: false, paired: false })).toBe("code-expired");
    expect(failureOf(mux("auth_failed"), paired)).toBe("revoked");
    expect(failureOf(mux("auth_revoked"), paired)).toBe("revoked");
    expect(failureOf(new ServerIdentityChangedError("12".repeat(16)), paired)).toBe("identity-changed");
    expect(failureOf(mux("auth_changed"), paired)).toBe("pc-offline");
    expect(forgetsDevice(failureOf(mux("auth_changed"), paired))).toBe(false);
  });

  it("keeps the saved key when the PC could not check its account, or must be added to it again", () => {
    for (const [code, failure] of [["account_unreachable", "account-unreachable"], ["account_readd_required", "account-readd"]]) {
      const refusal = Object.assign(new MuxProtocolError("protocol_error", "PC refused"), { code });
      expect<string>(failureOf(refusal, paired)).toBe(failure!);
      expect(forgetsDevice(failureOf(refusal, paired))).toBe(false);
      expect(pairsAgainWithoutKey(refusal, { code: false, paired: true, codeless: true })).toBe(false);
    }
  });

  it("asks for an update on a protocol the two sides do not share, and calls an unsafe offer damaged", () => {
    expect(failureOf(mux("unsupported_version"), paired)).toBe("needs-update");
    expect(failureOf(mux("unsupported_extension"), pairing)).toBe("needs-update");
    expect(failureOf(new UnsafeRelayDestinationError("relay"), pairing)).toBe("bad-offer");
    expect(failureOf(mux("protocol_error"), paired)).toBe("relay-unreachable");
  });

  it("forgets the saved key only when the PC removed the phone", () => {
    expect(forgetsDevice("revoked")).toBe(true);
    for (const failure of ["pc-offline", "pc-unresponsive", "relay-unreachable", "needs-update", "identity-changed", "code-expired", "bad-offer"] as const) expect(forgetsDevice(failure)).toBe(false);
  });
});

describe("the iPhone browser tab", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  it("is an iPhone or iPad that is not installed", () => {
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: undefined })).toBe(true);
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: true })).toBe(false);
    expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 0, standalone: undefined })).toBe(false);
    expect(iosBrowserTab({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120", maxTouchPoints: 5, standalone: undefined })).toBe(false);
  });

  for (const platform of ["ios", "android"]) {
    it(`does not show the home-screen hint inside the ${platform} app`, () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => platform,
      } });
      try {
        expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: undefined })).toBe(false);
        expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 5, standalone: false })).toBe(false);
      } finally {
        if (original) Object.defineProperty(globalThis, "Capacitor", original);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });
  }
});

describe("shell mode", () => {
  const document = (content: string | null) => ({ querySelector: (selector: string) => selector === 'meta[name="ovis-shell"]' && content !== null ? { getAttribute: () => content } : null });

  it("is the meta the shell build writes and nothing else", () => {
    expect(shellModeOf(document("relay"))).toBe("relay");
    expect(shellModeOf(document(null))).toBeNull();
    expect(shellModeOf(document("other"))).toBeNull();
  });

  it("knows a PC's scope, its worker and the front page", () => {
    const id = "ab".repeat(16);
    expect(serverScopePath(id)).toBe(`/s/${id}/`);
    expect(serverIdOfPath(`/s/${id}/`)).toBe(id);
    expect(serverIdOfPath(`/s/${id}`)).toBe(id);
    expect(serverIdOfPath(`/s/${id}/index.html`)).toBe(id);
    expect(serverIdOfPath("/")).toBeNull();
    expect(serverIdOfPath("/s/")).toBeNull();
    expect(serverIdOfPath(`/s/${id}x/`)).toBeNull();
    expect(serverIdOfPath(`/s/${id.toUpperCase()}/`)).toBeNull();
    expect(shellServiceWorker(`/s/${id}/`)).toEqual({ script: `/s/${id}/sw.js`, scope: `/s/${id}/` });
    expect(shellServiceWorker("/")).toBeNull();
  });
});

describe("the offer fragment", () => {
  const page = (href: string) => {
    const url = new URL(href);
    const replaced: string[] = [];
    const listeners = new Map<string, () => void>();
    return {
      replaced,
      listeners,
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      location: { href, pathname: url.pathname, search: url.search, hash: url.hash },
      history: { state: null as unknown, replaceState: (_data: unknown, _unused: string, to: string) => replaced.push(to) },
    };
  };

  it("leaves the address bar before anything else, and the entry keeps it", () => {
    const offer = encodeOffer(testOffer(), APP);
    const with_ = page(offer);
    expect(takeEntryUrl(with_)).toBe(offer);
    expect(with_.replaced).toEqual([`/s/${"12".repeat(16)}/`]);
    const linked = page(`${APP}/s/${"12".repeat(16)}/#pane=p1`);
    expect(takeEntryUrl(linked)).toBe(`${APP}/s/${"12".repeat(16)}/#pane=p1`);
    expect(linked.replaced).toEqual([]);
    for (const hash of ["#overview", "#pcs?filter=needs", "#devices", "#relay", "#settings", "#relay-dash-pcs"]) {
      const dashboard = page(`${APP}/${hash}`);
      expect(takeEntryUrl(dashboard)).toBe(`${APP}/${hash}`);
      expect(dashboard.replaced).toEqual([]);
      expect(shellEntry(`${APP}/${hash}`)).toEqual({ serverId: null, offer: null, damaged: false });
    }
  });

  it("takes a sign-in's return off the address before the shell loads, and the entry keeps it", () => {
    const returned = page(`${APP}/#code=secret&state=s1`);
    expect(takeEntryUrl(returned)).toBe(`${APP}/#code=secret&state=s1`);
    expect(returned.replaced).toEqual(["/"]);
  });

  it("moves a query from before the fragment carried it into the fragment, off the next request", () => {
    const old = page(`${APP}/s/${"12".repeat(16)}/?file=%2Fhome%2Fme%2Fa.md`);
    expect(takeEntryUrl(old)).toBe(`${APP}/s/${"12".repeat(16)}/?file=%2Fhome%2Fme%2Fa.md`);
    expect(old.replaced).toEqual([`/s/${"12".repeat(16)}/#file=%2Fhome%2Fme%2Fa.md`]);
    const offer = encodeOffer(testOffer(), APP);
    const both = page(`${APP}/s/${"12".repeat(16)}/?pane=p1&view=terminal${offer.slice(offer.indexOf("#"))}`);
    takeEntryUrl(both);
    expect(both.replaced).toEqual([`/s/${"12".repeat(16)}/#pane=p1&view=terminal`]);
    const anchored = page(`${APP}/s/${"12".repeat(16)}/?read=%2Fa.md#auth=x`);
    takeEntryUrl(anchored);
    expect(anchored.replaced).toEqual([`/s/${"12".repeat(16)}/#read=%2Fa.md`]);
  });

  it("is taken off before boot loads, requests or opens anything, and the shell gets it whole", async () => {
    const offer = encodeOffer(testOffer(), APP);
    const loaded = page(offer);
    const order: string[] = [];
    const replace = loaded.history.replaceState;
    loaded.history.replaceState = (data, unused, to) => { order.push("address"); return replace(data, unused, to); };
    const saved = { window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    const mounted = Promise.withResolvers<string>();
    Object.assign(globalThis, {
      window: loaded,
      fetch: () => { order.push("fetch"); return new Promise(() => {}); },
      WebSocket: function () { order.push("socket"); },
    });
    try {
      bootRelayShell({ querySelector: () => null, dataset: {} } as unknown as HTMLElement, () => ({}) as Root, () => {
        order.push("load");
        const shell = { mountRelayShell: async ({ entryUrl }: RelayShellMount) => { mounted.resolve(entryUrl); } };
        return Promise.resolve(shell as Awaited<ReturnType<typeof loadRelayShell>>);
      });
      expect(order).toEqual(["address", "load"]);
      expect(loaded.replaced).toEqual([`/s/${"12".repeat(16)}/`]);
      expect(await mounted.promise).toBe(offer);
      expect(order).toEqual(["address", "load"]);
      loaded.location.search = "?file=%2Fa.md";
      loaded.listeners.get("popstate")?.();
      expect(loaded.replaced.at(-1)).toBe(`/s/${"12".repeat(16)}/#file=%2Fa.md`);
    } finally {
      Object.assign(globalThis, saved);
      // Bun has no window of its own: leave none behind
      if (saved.window === undefined) delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("a link without a code on a phone that holds an old key", () => {
  const refused = new MuxProtocolError("auth_failed", "auth_failed");
  it("drops the key and compares digits once, after the PC refused the old key", () => {
    expect(pairsAgainWithoutKey(refused, { code: false, paired: false, codeless: true })).toBe(true);
  });
  it("never for a code, after digits were compared, a second time, or another error", () => {
    expect(pairsAgainWithoutKey(refused, { code: true, paired: false, codeless: false })).toBe(false);
    expect(pairsAgainWithoutKey(refused, { code: false, paired: false, codeless: true, compared: true })).toBe(false);
    expect(pairsAgainWithoutKey(refused, { code: false, paired: false, codeless: true, refreshed: true })).toBe(false);
    expect(pairsAgainWithoutKey(refused, { code: false, paired: true, codeless: false })).toBe(false);
    expect(pairsAgainWithoutKey(new MuxProtocolError("timeout", "timeout"), { code: false, paired: false, codeless: true })).toBe(false);
  });
});

describe("a link without a code that the PC refused before any digits", () => {
  const refused = new MuxProtocolError("auth_failed", "auth_failed");
  it("says the PC is not taking new phones now, not that a code expired", () => {
    expect(failureOf(refused, { code: false, paired: false, codeless: true })).toBe("pair-unavailable");
  });
  it("keeps the code and saved-key screens for the attempts that have them", () => {
    expect(failureOf(refused, { code: true, paired: false })).toBe("code-expired");
    expect(failureOf(refused, { code: false, paired: true })).toBe("revoked");
    expect(failureOf(refused, { code: false, paired: false, codeless: true, compared: true })).toBe("pair-declined");
  });

  it("preview-qa #16: once the number was shown, only the PC's refusal reads as declined; a timeout or a lost session is no answer", () => {
    const compared = { code: false, paired: false, codeless: true, compared: true };
    expect(failureOf(new MuxProtocolError("auth_failed", "declined"), compared)).toBe("pair-declined");
    // a join that brought this device's card, which no entry of the account's list let in: the PC says which cause it was
    for (const [cause, failure] of [["list_not_claimed", "list-not-claimed"], ["list_service_away", "list-not-placed"], ["list_head_lost", "list-not-placed"],
      ["list_not_in", "list-not-in"], ["list_pc_behind", "list-pc-behind"], ["list_not_signer", "list-pc-invited"],
      ["list_needs_keys", "list-pc-needs-keys"], ["list_held_here", "list-pc-held"], ["list_refused", "list-refused"]] as const) {
      expect(failureOf(new MuxProtocolError("auth_failed", cause), compared)).toBe(failure);
    }
    // any other word of the PC's is a decline, as before
    expect(failureOf(new MuxProtocolError("auth_failed", "list_something_new"), compared)).toBe("pair-declined");
    // a word that names something every object has is no cause either
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(failureOf(new MuxProtocolError("auth_failed", word), compared)).toBe("pair-declined");
    // and a PC that follows another list than this device's account's, before any digits
    expect(failureOf(new ListMismatchError(), { code: false, paired: false, codeless: true })).toBe("list-other");
    expect(failureOf(new MuxProtocolError("timeout", "no approval in time"), compared)).toBe("pair-unanswered");
    expect(failureOf(new RelayAdmissionTimeoutError("welcome"), compared)).toBe("pair-unanswered");
    expect(failureOf(new MuxProtocolError("internal_error", "upstream_lost"), compared)).toBe("pair-unanswered");
    expect(failureOf(new RelayUnreachableError(null), compared)).toBe("pair-unanswered");
  });
});

describe("the start screen while the shell loads", () => {
  class Node {
    isConnected = true; className = ""; children: Node[] = []; parent: Node | null = null;
    readonly classList = { names: new Set<string>(), add: (name: string) => { this.classList.names.add(name); } };
    constructor(readonly selector = "") {}
    querySelector(selector: string): Node | null { return this.children.find((child) => child.selector === selector) ?? null; }
    append(child: Node): void { child.parent = this; this.children.push(child); }
    replaceWith(next: Node): void { const parent = this.parent!; parent.children[parent.children.indexOf(this)] = next; next.parent = parent; this.isConnected = false; }
  }
  const page = () => { const root = new Node(), boot = new Node(".boot"), ring = new Node(".boot-spinner"); root.append(boot); boot.append(ring); return { root, boot, ring }; };
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  beforeEach(() => {
    for (const key of ["document", "window"]) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Node() } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  });
  afterEach(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("keeps the loading ring and its words until the sheep is drawn, then puts the sheep in its place", async () => {
    const { root, boot, ring } = page();
    const drawn: string[] = [];
    const loaded = Promise.withResolvers<void>();
    const shown = showStart(root as unknown as ParentNode, async () => {
      await loaded.promise;
      return { SMALL_BELOW_PX: 96, playMascot: (_host: HTMLElement, state: string) => { drawn.push(state); return () => {}; } } as never;
    });
    expect(boot.children).toEqual([ring]);
    expect(boot.classList.names.has("relay-start")).toBe(false);
    loaded.resolve();
    await shown;
    expect(ring.isConnected).toBe(false);
    expect(boot.children.map((child) => child.className)).toEqual(["sheep-badge sheep-badge-112"]);
    expect(boot.classList.names.has("relay-start")).toBe(true);
    expect(drawn).toEqual(["hello"]);
  });

  it("leaves the page alone when the shell's first screen took it before the sheep loaded", async () => {
    const { root, boot, ring } = page();
    const drawn: string[] = [];
    await showStart(root as unknown as ParentNode, async () => {
      ring.isConnected = false;
      return { SMALL_BELOW_PX: 96, playMascot: (_host: HTMLElement, state: string) => { drawn.push(state); return () => {}; } } as never;
    });
    expect(boot.children).toEqual([ring]);
    expect(boot.classList.names.has("relay-start")).toBe(false);
    expect(drawn).toEqual([]);
  });
});
