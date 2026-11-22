import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { decodeOffer, encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayShellMount } from "./shellState.ts";

const SERVICE = "https://account.ovis.sh";
const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.ovis.sh";

async function within<T>(what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: did not happen`)), 1_000); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

type PcKey = ReturnType<typeof pcKey>;
const pcKey = () => {
  const identity = generateKeyPair();
  return { server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), public_key: Buffer.from(identity.publicKey).toString("hex") };
};

describe("a PC's own page on a device that has no pairing for it", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { setTransport(nativeTransport); browser.dispose(); });

  const land = (page: PcKey, options: { readonly listed: readonly PcKey[]; readonly saved?: boolean; readonly held?: boolean; readonly heldStore?: boolean; readonly heldSession?: boolean; readonly signInId?: string; readonly entryUrl?: string }) => {
    const memory = memoryAccountStore();
    let holdSession = false;
    const accountStore: typeof memory = { ...memory, update: async (name, change) => {
      if (name === "session" && holdSession) { holdSession = false; session.resolve(); await held.promise; }
      return memory.update(name, change);
    } };
    const now = Date.now();
    const pcs = options.listed.map((pc, index) => ({ server_id: pc.server_id, label: `PC ${index}`, relay: RELAY, public_key: pc.public_key,
      added_at: new Date(now - 3_600_000).toISOString(), last_seen_at: new Date(now - 30_000).toISOString() }));
    const held = Promise.withResolvers<void>(), fetched = Promise.withResolvers<void>(), compared = Promise.withResolvers<void>(), connected = Promise.withResolvers<void>(), stored = Promise.withResolvers<void>(), session = Promise.withResolvers<void>();
    const paths: string[] = [];
    const drawn: RelayShellProps[] = [];
    const opened: { readonly code: boolean; readonly compares: boolean }[] = [];
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) return;
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { drawn.push(node.props); return; }
      render(node.props.children);
    };
    const saved: RelayDevice | undefined = options.saved
      ? { server_id: page.server_id, device_id: "0".repeat(16), private_key: {} as CryptoKey, public_spki: "spki", label: "Phone", server_public_key: page.server_public_key, relay: RELAY, name: "Desk" }
      : undefined;
    const store: ShellDeviceStore = {
      get: async () => {
        if (options.heldStore) { stored.resolve(); await held.promise; }
        if (options.heldSession) holdSession = true;
        return saved;
      }, list: async () => [], remove: async () => {}, removeRow: async () => false,
      update: async () => { throw new TypeError("Pairing has not been approved by the PC"); },
    };
    const mount: RelayShellMount = {
      container: Object.create(null), entryUrl: options.entryUrl ?? `${APP}/s/${page.server_id}/`, shellVersion: "1.0.0",
      store, label: "Phone", accountStore, accountService: SERVICE,
      accountFetch: async () => { fetched.resolve(); if (options.held) await held.promise; return Response.json({ pcs }); },
      createRoot: () => ({ render, unmount() {} }),
      renderApp: () => { throw new TypeError("Pairing has not finished"); },
      navigate: (path) => { paths.push(path); },
      open: async (offer, connect) => {
        opened.push({ code: offer.code !== undefined, compares: connect?.compare !== undefined });
        connected.resolve();
        if (connect?.compare) { await connect.compare("123456"); compared.resolve(); }
        return await new Promise<never>(() => {});
      },
    };
    const mounted = (async () => {
      await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000, ...(options.signInId ? { sign_in_id: options.signInId } : {}) });
      await mountRelayShell(mount);
    })();
    return { paths, drawn, opened, mount, mounted, connected: connected.promise, stored: stored.promise, session: session.promise, held, fetched: fetched.promise, compared: compared.promise, last: () => drawn.at(-1) };
  };

  it("offers that PC's join there, with no list of PCs, asks nothing until its press, then runs it with no second press", async () => {
    const page = pcKey();
    const at = land(page, { listed: [page] });
    await within("the page's load", at.mounted);
    expect(at.drawn.map((props) => props.state.kind).filter((kind) => kind === "list" || kind === "empty")).toEqual([]);
    expect(at.paths).toHaveLength(1);
    const link = new URL(at.paths[0]!, at.mount.entryUrl);
    expect(link.pathname).toBe(`/s/${page.server_id}/`);
    expect(decodeOffer(link.href)?.server_id).toBe(page.server_id);
    expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "join", server_id: page.server_id, alone: true });
    expect(browser.sessionStore.get("ovis-confirmed-pc")).toBeUndefined();

    const join = land(page, { listed: [page], entryUrl: link.href });
    await within("the join page's load", join.mounted);
    expect(join.last()?.state).toMatchObject({ kind: "confirm", alone: true });
    expect(join.opened).toEqual([]);
    expect(join.last()?.sheetJoin).toMatchObject({ mode: "join", server_id: page.server_id, alone: true });
    expect("continuedAccount" in join.last()!).toBe(false);

    join.last()!.onPair();
    await within("the join's comparison", join.compared);
    expect(join.opened).toEqual([{ code: false, compares: true }]);
    expect(join.last()?.state).toMatchObject({ kind: "compare", digits: "123456", confirmed: true, alone: true });
  });

  it.each([true, false])("lets a link opened while the page reads the account win (the account lists the PC: %p)", async (listed) => {
    const page = pcKey();
    const at = land(page, { listed: listed ? [page] : [], held: true });
    await within("the account read", at.fetched);
    const scanned = encodeOffer({ v: 1, server_id: page.server_id, server_public_key: page.server_public_key, relay: RELAY, name: "Desk", code: "123456" }, APP);
    const url = new URL(scanned);
    Object.assign(window.location, { href: scanned, hash: url.hash, pathname: url.pathname });
    window.dispatchEvent(new Event("hashchange"));
    expect(at.last()?.state).toMatchObject({ kind: "confirm", offer: { code: "123456" } });
    at.held.resolve();
    await within("the page's load", at.mounted);
    expect(at.paths).toEqual([]);
    expect(browser.sessionStore.get("ovis-add-pc-sheet")).toBeUndefined();
    expect(at.last()?.state).toMatchObject({ kind: "confirm", offer: { code: "123456" } });
    expect(at.opened).toEqual([]);
  });

  it("lets a link opened while the page reads its saved pairing win over that pairing's connection", async () => {
    const page = pcKey();
    const at = land(page, { listed: [], saved: true, heldStore: true });
    await within("the saved pairing's read", at.stored);
    const scanned = encodeOffer({ v: 1, server_id: page.server_id, server_public_key: page.server_public_key, relay: RELAY, name: "Desk", code: "123456" }, APP);
    const url = new URL(scanned);
    Object.assign(window.location, { href: scanned, hash: url.hash, pathname: url.pathname });
    window.dispatchEvent(new Event("hashchange"));
    at.held.resolve();
    await within("the page's load", at.mounted);
    expect(at.opened).toEqual([]);
    expect(at.last()?.state).toMatchObject({ kind: "confirm", offer: { code: "123456" } });
  });

  it("lets a link opened while the page reads the sign-in its pairing was confirmed under win over that pairing's connection", async () => {
    const page = pcKey(), other = pcKey();
    browser.sessionStore.set("ovis-confirmed-sign-in", JSON.stringify({ server_id: page.server_id, sign_in_id: "sign-in-1" }));
    const at = land(page, { listed: [], saved: true, heldSession: true, signInId: "sign-in-1" });
    await within("the sign-in's read", at.session);
    const scanned = encodeOffer({ v: 1, server_id: other.server_id, server_public_key: other.server_public_key, relay: RELAY, name: "Other", code: "654321" }, APP);
    const url = new URL(scanned);
    Object.assign(window.location, { href: scanned, hash: url.hash, pathname: url.pathname });
    window.dispatchEvent(new Event("hashchange"));
    expect(at.last()?.state).toMatchObject({ kind: "confirm", offer: { server_id: other.server_id } });
    at.held.resolve();
    await within("the page's load", at.mounted);
    expect(at.opened).toEqual([]);
    expect(at.last()?.state).toMatchObject({ kind: "confirm", offer: { server_id: other.server_id } });
  });

  it("starts no join for a PC its page was left for while the account was still read", async () => {
    const page = pcKey();
    const at = land(page, { listed: [page], held: true });
    await within("the account read", at.fetched);
    at.last()!.onCancel();
    expect(at.paths).toEqual(["/"]);
    at.held.resolve();
    await within("the page's load", at.mounted);
    expect(at.paths).toEqual(["/"]);
    expect(browser.sessionStore.get("ovis-add-pc-sheet")).toBeUndefined();
    expect(at.opened).toEqual([]);
  });

  it("joins only the PC its page names: another PC of the account to join is left alone", async () => {
    const page = pcKey(), other = pcKey();
    const at = land(page, { listed: [other] });
    await within("the page's load", at.mounted);
    expect(at.paths).toEqual([]);
    expect(at.last()?.state.kind).toBe("empty");
    expect(at.opened).toEqual([]);
  });

  it("opens a PC this device already pairs with by that pairing, never by a join", async () => {
    const page = pcKey();
    const at = land(page, { listed: [page], saved: true });
    await within("the saved pairing's connection", at.connected);
    expect(at.paths).toEqual([]);
    expect(at.opened).toHaveLength(1);
    expect(browser.sessionStore.get("ovis-add-pc-sheet")).toBeUndefined();
  });
});
