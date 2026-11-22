import { expect, it } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { pairChallenge, pairFingerprint, verifyPairProof } from "../../../shared/pair-fingerprint.ts";
import { encodeFrame, FrameType, KEY_PROOF_FEATURE } from "../../../shared/relay-mux.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { mountRelayShell } from "./shell.tsx";
import type { RelayShellMount } from "./shellState.ts";
import { accountOpenPeer } from "./accountOpenPeer.fixture.ts";
import { openRelayTransport } from "./transport.ts";

async function mountPairing(open: NonNullable<RelayShellMount["open"]>, pc = generateKeyPair(), onRender?: () => void) {
  const browser = createShellTestPage();
  browser.setVisibility("hidden");
  const app = "https://app.ovis.sh";
  const entryUrl = encodeOffer({
    v: 1, server_id: deriveServerId(pc.publicKey), server_public_key: exportPublicKey(pc.publicKey),
    relay: "wss://relay.ovis.sh", code: "123456", name: "Desk",
  }, app);
  const store: ShellDeviceStore = {
    get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false,
    update: async (_id, change) => change(undefined),
  };
  let props: RelayShellProps | undefined;
  const render = (node: ReactNode): void => {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell");
    if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; onRender?.(); return; }
    render(node.props.children);
  };
  const current = (): RelayShellProps => {
    if (props === undefined) throw new TypeError("Missing shell props");
    return props;
  };
  const markup = () => renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayShell, current())));
  const destinations: string[] = [];
  const mount: RelayShellMount = {
    entryUrl, container: Object.create(null), store, shellVersion: "1.0.0", label: "Phone",
    accountStore: memoryAccountStore(), accountProviders: [],
    createRoot: () => ({ render, unmount() {} }),
    renderApp: () => { throw new TypeError("The PC has not approved the key"); },
    pendingPush: { get: async () => undefined, clear: async () => {} },
    navigate: (path) => { destinations.push(path); },
    open,
  };
  const dispose = () => { setTransport(nativeTransport); browser.dispose(); };
  try {
    await mountRelayShell(mount);
    return { current, markup, mount, destinations, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

it("T71, P11: a code pairing shows the pending fingerprint until the attempt is cancelled", async () => {
  const opening = Promise.withResolvers<Parameters<NonNullable<RelayShellMount["open"]>>[1]>();
  const { current, markup, mount, destinations, dispose } = await mountPairing(async (_offer, options) => {
      opening.resolve(options);
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("Pairing cancelled", "AbortError");
  });
  let cancel: (() => void) | undefined;
  try {
    current().onPair();
    const options = await opening.promise;
    cancel = current().onCancel;
    const fingerprint = "7RJ5-P9C2";
    expect(markup()).not.toContain(fingerprint);
    options?.keyProof?.(fingerprint);
    expect(markup()).toContain(fingerprint);
    cancel();
    cancel = undefined;
    expect(options?.signal?.aborted).toBe(true);
    const [destination] = destinations;
    if (destination !== "/") throw new TypeError("Cancel did not return to the front page");
    await mountRelayShell({ ...mount, entryUrl: new URL(destination, mount.entryUrl).href });
    options?.keyProof?.(fingerprint);
    expect(markup()).not.toContain(fingerprint);
  } finally {
    cancel?.();
    dispose();
  }
});

it("T71: pressing Pair offers key proof and shows the fingerprint after the encrypted PC reply", async () => {
  const pc = generateKeyPair();
  const serverId = deriveServerId(pc.publicKey);
  const challenge = pairChallenge();
  let offered = false;
  let publicKey: string | undefined;
  let fingerprint: string | undefined;
  const pendingRender = Promise.withResolvers<void>();
  const proved = Promise.withResolvers<string>();
  const { current, markup, dispose } = await mountPairing((offer, options) => openRelayTransport(offer, {
    ...options,
    socket: () => accountOpenPeer(pc, {
      features: [],
      auth: () => { throw new Error("Fresh Pair unexpectedly sent AUTH"); },
      hello: (frame) => { offered = frame.payload.features.includes(KEY_PROOF_FEATURE); },
      pair: async (frame) => {
        if (frame.type === FrameType.PAIR) {
          publicKey = frame.payload.public_key;
          if (!offered) {
            proved.reject(new Error("Pair did not offer key-proof-1"));
            throw new Error("Pair did not offer key-proof-1");
          }
          return encodeFrame({ type: FrameType.KEY_CHALLENGE, flags: 0, stream_id: 0, payload: { challenge } });
        }
        if (publicKey === undefined || !await verifyPairProof(serverId, challenge, publicKey, frame.payload.signature)) {
          proved.reject(new Error("The PC did not receive a valid proof"));
          throw new Error("The PC did not receive a valid proof");
        }
        fingerprint = await pairFingerprint(serverId, challenge, publicKey);
        proved.resolve(fingerprint);
        return encodeFrame({ type: FrameType.KEY_PENDING, flags: 0, stream_id: 0, payload: {} });
      },
    }),
  }), pc, () => { if (fingerprint !== undefined) pendingRender.resolve(); });
  try {
    current().onPair();
    const expected = await proved.promise;
    await pendingRender.promise;
    expect(markup()).toContain(expected);
  } finally {
    current().onCancel();
    dispose();
  }
});
