import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import type { MyPc } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayShellMount } from "./shellState.ts";

describe("explicit dashboard pairing consent", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  const drawn = new Map<string, PropertyDescriptor | undefined>();
  afterEach(() => {
    setTransport(nativeTransport); browser.dispose();
    for (const [key, descriptor] of drawn) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    drawn.clear();
  });

  const arrive = async (mode: "new" | "join", from = "") => {
    const identity = generateKeyPair();
    const pc: MyPc = {
      server_id: deriveServerId(identity.publicKey), name: "Desk", state: "needs-approval",
      last_seen_at: null, added_at: null, listed: true, paired: false, linked: false,
      join: { server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh" },
    };
    const paths: string[] = [];
    let props: RelayShellProps | undefined;
    let shown: (() => void) | undefined;
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; shown?.(); return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Missing shell props"); return props; };
    const until = (kind: RelayShellProps["state"]["kind"]): Promise<void> => new Promise((resolve) => { shown = () => { if (current().state.kind === kind) { shown = undefined; resolve(); } }; });
    const store: ShellDeviceStore = {
      get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false,
      update: async () => { throw new TypeError("Pairing has not been approved by the PC"); },
    };
    const compared = Promise.withResolvers<void>(), approved = Promise.withResolvers<void>();
    const mount: RelayShellMount = {
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", shellVersion: "1.0.0",
      store, label: "Phone", accountStore: memoryAccountStore(), accountService: "https://account.ovis.sh",
      accountFetch: async () => Response.json({ pcs: [] }),
      createRoot: () => ({ render, unmount() {} }),
      renderApp: () => { throw new TypeError("Pairing has not finished"); },
      navigate: (path) => { paths.push(path); },
      open: async (_offer, options) => {
        if (!options?.compare) throw new TypeError("Pairing must require a PC comparison");
        const pending = options.compare("123456");
        compared.resolve();
        await pending;
        approved.resolve();
        throw new TypeError("The test ends the pairing after the comparison");
      },
    };
    await mountRelayShell(mount);
    Object.assign(window.location, { hash: from });
    const join = current().onJoin;
    if (!join) throw new TypeError("Account pairing action is missing");
    join(pc, { sheet: mode, typed: mode === "new" });
    const path = paths[0];
    if (!path) throw new TypeError("The selected PC did not receive a scoped navigation");
    const scoped = { ...mount, entryUrl: new URL(path, mount.entryUrl).href };
    await mountRelayShell(scoped);
    await compared.promise;
    return { pc, current, until, paths, approved: approved.promise, again: () => mountRelayShell(scoped) };
  };

  it.each(["new", "join"] as const)("starts the %s sheet's comparison after one confirmation", async (mode) => {
    const { pc, current, again } = await arrive(mode);
    const state = current().state;
    expect(state).toMatchObject({ kind: "compare", confirmed: false });
    expect(state.kind === "compare" && state.typed === true).toBe(mode === "new");
    expect(current().sheetJoin).toMatchObject({ mode, server_id: pc.server_id });
    current().onCancel();
    await again();
    expect(current().state.kind).toBe("confirm");
  });

  it.each(["#my-machines", "#my-machines?machine=0123456789abcdef0123456789abcdef", "#pcs?filter=needs"])("goes back to %s, where the join was started, when it is cancelled", async (from) => {
    const { current, paths } = await arrive("join", from);
    current().onCancel();
    expect(paths.at(-1)).toBe(`/${from}`);
  });

  it("turns a typed comparison into the join sheet's when the PC shows no number: this device's digits show and their match approves the same request", async () => {
    const { pc, current, approved } = await arrive("new");
    expect(current().state).toMatchObject({ kind: "compare", digits: "", typed: true });
    current().onJoinInstead?.();
    expect(current().state).toEqual({ kind: "compare", name: "Desk", digits: "123456", confirmed: false, challenge: 1 });
    expect(current().sheetJoin).toMatchObject({ mode: "join", server_id: pc.server_id });
    expect(browser.sessionStore.has("ovis-typed-join")).toBe(false);
    expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "join", server_id: pc.server_id });
    current().onMatch();
    expect(current().state).toMatchObject({ kind: "compare", digits: "123456", confirmed: true });
    await approved;
  });

  it("draws Ask to join on the continued sheet's typed comparison, and a Try again after it fails asks to join again", async () => {
    const { current, until } = await arrive("new");
    const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} });
    const globals = { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: class { isConnected = true; focus(): void {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }) };
    for (const [key, value] of Object.entries(globals)) { drawn.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
    Object.assign(window, { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    Object.assign(document, { body: { nodeType: 1, children: [], createNodeMock: node }, activeElement: null, querySelectorAll: () => [] });
    let sheet!: ReactTestRenderer;
    await act(async () => { sheet = create(createElement(SettingsProvider, { children: createElement(RelayShell, current()) }), { createNodeMock: node }); });
    await act(async () => { sheet.root.findByProps({ "data-action": "ask-to-join" }).props.onClick(); });
    await act(async () => { sheet.unmount(); });
    expect(current().state).toMatchObject({ kind: "compare", digits: "123456", confirmed: false });
    const failed = until("failed");
    current().onMatch();
    await failed;
    const compared = until("compare");
    current().onRetry();
    await compared;
    expect(current().state).toMatchObject({ kind: "compare", digits: "123456", confirmed: false });
    expect(current().sheetJoin?.mode).toBe("join");
  });
});
